import type { Browser, Page } from 'puppeteer';
import logger from './logger.js';

const QR_WAIT_MS = 45_000;
const MAX_DATA_URL_CHARS = 400_000;
/** 截屏左右留白，让二维码在画面中更居中 */
const CLIP_PAD_X = 40;
/** 截屏上方留白 */
const CLIP_PAD_TOP = 24;
/** 截屏下方留白（宜小，避免裁进 Instructions） */
const CLIP_PAD_BOTTOM = 12;
/** 截屏前把二维码放大到该边长，贴近示意效果 */
const QR_DISPLAY_SIZE = 220;

export type ProxyAuth = { username: string; password: string };

export type PaymentQrCapture = {
    /** 区域截屏得到的图片 data URL（data:image/png;base64,...） */
    dataUrl?: string;
    /** 取码失败原因（供网页端展示） */
    error?: string;
};

type ClipRect = { x: number; y: number; width: number; height: number };

/** 计算「扫码提示文案 + 二维码」区域，并按二维码中心左右对称留白 */
async function resolveQrClip(page: Page): Promise<ClipRect> {
    const clip = await page.evaluate((padX, padTop, padBottom) => {
        const qr = document.querySelector('#qrcode') as HTMLElement | null;
        const img = qr?.querySelector('img') as HTMLImageElement | null;
        if (!qr || !img || img.naturalWidth < 50) return null;

        // 取面积最小的匹配节点，避免命中整块 .qr-section 容器
        let tip: HTMLElement | null = null;
        let tipArea = Number.POSITIVE_INFINITY;
        for (const el of Array.from(document.querySelectorAll('p, div, span, h1, h2, h3, label'))) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!/Scan the QR code with GCash/i.test(text) || text.length >= 120) continue;
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > 0 && area < tipArea) {
                tip = el as HTMLElement;
                tipArea = area;
            }
        }

        const imgRect = img.getBoundingClientRect();
        const tipRect = tip?.getBoundingClientRect();
        const contentLeft = tipRect ? Math.min(tipRect.left, imgRect.left) : imgRect.left;
        const contentRight = tipRect ? Math.max(tipRect.right, imgRect.right) : imgRect.right;
        // 上沿用提示文案；若提示节点过高（容器），至少盖住文案顶部
        const contentTop = tipRect ? Math.min(tipRect.top, imgRect.top) : imgRect.top;
        const contentBottom = imgRect.bottom;

        const qrCenterX = imgRect.left + imgRect.width / 2;
        let halfW = Math.max(qrCenterX - contentLeft, contentRight - qrCenterX, imgRect.width / 2);
        halfW += padX;
        let left = qrCenterX - halfW;
        let right = qrCenterX + halfW;
        let top = contentTop - padTop;
        let bottom = contentBottom + padBottom;

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        left = Math.max(0, Math.floor(left));
        top = Math.max(0, Math.floor(top));
        right = Math.min(vw, Math.ceil(right));
        bottom = Math.min(vh, Math.ceil(bottom));

        const width = right - left;
        const height = bottom - top;
        if (width < 80 || height < 80) return null;
        return { x: left, y: top, width, height };
    }, CLIP_PAD_X, CLIP_PAD_TOP, CLIP_PAD_BOTTOM);
    if (!clip) throw new Error('无法定位二维码截屏区域');
    return clip;
}

/**
 * 用当前浏览器新开标签打开提链页，二维码加载后区域截屏（提示文案 + 二维码）。
 * 取码成功后故意不关支付页，避免服务端判定会话失效导致扫码无效；
 * 页面随延迟关闭结束时浏览器一起退出。失败返回 error，不影响主流程。
 */
export async function capturePaymentQr(
    browser: Browser,
    paymentLink: string,
    proxyAuth?: ProxyAuth | null,
): Promise<PaymentQrCapture | undefined> {
    const link = paymentLink.trim();
    if (!link) return undefined;

    const page = await browser.newPage();
    /** 取码成功则保持标签打开，供扫码期间会话继续有效 */
    let keepOpen = false;
    try {
        await page.setViewport({ width: 420, height: 900 });
        if (proxyAuth && (proxyAuth.username || proxyAuth.password)) {
            await page.authenticate({
                username: proxyAuth.username,
                password: proxyAuth.password,
            });
        }

        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(
            () => {
                const img = document.querySelector('#qrcode img') as HTMLImageElement | null;
                const src = img?.getAttribute('src') || '';
                if (!src.startsWith('data:image')) return false;
                return !!img && img.naturalWidth >= 50;
            },
            { timeout: QR_WAIT_MS },
        );

        await page.$eval('#qrcode', (el) => {
            el.scrollIntoView({ block: 'center', inline: 'center' });
        });
        // 放大二维码，截屏更接近示意效果；不影响页面会话本身
        await page.$eval('#qrcode img', (img, size) => {
            const el = img as HTMLImageElement;
            el.style.width = `${size}px`;
            el.style.height = `${size}px`;
            el.style.maxWidth = 'none';
            el.style.maxHeight = 'none';
        }, QR_DISPLAY_SIZE);
        await new Promise((resolve) => setTimeout(resolve, 250));

        const clip = await resolveQrClip(page);
        const bytes = await page.screenshot({
            type: 'png',
            clip,
            captureBeyondViewport: false,
        });
        const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
        if (dataUrl.length > MAX_DATA_URL_CHARS) {
            throw new Error('二维码截屏过大，已跳过回传');
        }
        logger.info(
            '已区域截屏支付二维码（%sx%s，%s 字符），保持支付页打开直至延迟关闭',
            clip.width,
            clip.height,
            dataUrl.length,
        );
        keepOpen = true;
        return { dataUrl };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 网页端只展示业务文案；具体异常留给 Actions 日志
        const tip = '支付链接已就绪，但二维码获取失败';
        logger.warn('提取支付二维码失败（不影响主流程）：%s', message);
        return { error: tip };
    } finally {
        if (!keepOpen) {
            await page.close().catch(() => undefined);
        }
    }
}

/** @deprecated 兼容旧调用名 */
export async function capturePaymentQrDataUrl(
    browser: Browser,
    paymentLink: string,
    proxyAuth?: ProxyAuth | null,
): Promise<string | undefined> {
    const captured = await capturePaymentQr(browser, paymentLink, proxyAuth);
    return captured?.dataUrl;
}
