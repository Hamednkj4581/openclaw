import type { Browser } from 'puppeteer';
import logger from './logger.js';

const QR_WAIT_MS = 45_000;
const MAX_DATA_URL_CHARS = 400_000;

export type ProxyAuth = { username: string; password: string };

export type PaymentQrCapture = {
    /** 页面内二维码图片 data URL（data:image/...;base64,...） */
    dataUrl?: string;
    /** 取码失败原因（供网页端展示） */
    error?: string;
};

/**
 * 用当前浏览器新开标签打开提链页，读取 #qrcode img 的 data URL 图片。
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
        const handle = await page.waitForFunction(
            () => {
                const img = document.querySelector('#qrcode img') as HTMLImageElement | null;
                const src = img?.getAttribute('src') || '';
                if (!src.startsWith('data:image')) return null;
                if (!img || img.naturalWidth < 50) return null;
                return src;
            },
            { timeout: QR_WAIT_MS },
        );
        const dataUrl = String(await handle.jsonValue() || '').trim();
        if (!dataUrl.startsWith('data:image')) {
            throw new Error('二维码图片未就绪');
        }
        if (dataUrl.length > MAX_DATA_URL_CHARS) {
            throw new Error('二维码图片过大，已跳过回传');
        }
        logger.info('已从提链页提取二维码图片（%s 字符），保持支付页打开直至延迟关闭', dataUrl.length);
        keepOpen = true;
        return { dataUrl };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const tip = `提取支付二维码失败：${message}`.slice(0, 160);
        logger.warn('%s（不影响主流程）', tip);
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
