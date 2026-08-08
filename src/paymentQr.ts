import type { Browser } from 'puppeteer';
import logger from './logger.js';

const QR_WAIT_MS = 45_000;
const MAX_DATA_URL_CHARS = 400_000;

export type ProxyAuth = { username: string; password: string };

export type PaymentQrCapture = {
    /** 页面内二维码图片 data URL */
    dataUrl: string;
    /** 二维码内容对应的 URL（优先接口 shortUrl） */
    qrUrl?: string;
};

function pickQrUrlFromPayload(data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const result = (data as { result?: unknown }).result;
    if (!result || typeof result !== 'object') return '';
    const row = result as Record<string, unknown>;
    for (const key of ['shortUrl', 'short_url', 'qrUrl', 'qr_url'] as const) {
        const value = row[key];
        if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
    }
    const code = row.qrCode ?? row.qr_code;
    if (typeof code === 'string' && /^https?:\/\//i.test(code.trim())) return code.trim();
    return '';
}

/**
 * 用当前浏览器新开标签打开提链页，读取 #qrcode img 与二维码对应 URL。
 * 失败只告警并返回 undefined（不影响主流程）。
 */
export async function capturePaymentQr(
    browser: Browser,
    paymentLink: string,
    proxyAuth?: ProxyAuth | null,
): Promise<PaymentQrCapture | undefined> {
    const link = paymentLink.trim();
    if (!link) return undefined;

    const page = await browser.newPage();
    let qrUrl = '';
    try {
        await page.setViewport({ width: 420, height: 900 });
        if (proxyAuth && (proxyAuth.username || proxyAuth.password)) {
            await page.authenticate({
                username: proxyAuth.username,
                password: proxyAuth.password,
            });
        }

        page.on('response', async (response) => {
            try {
                if (!/mgw\.htm/i.test(response.url())) return;
                if (qrUrl) return;
                const data = await response.json().catch(() => null);
                const picked = pickQrUrlFromPayload(data);
                if (picked) qrUrl = picked;
            } catch {
                // 忽略单次响应解析失败
            }
        });

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
        // 接口可能稍晚于图片就绪，再等一小会儿
        if (!qrUrl) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        logger.info('已从提链页提取二维码（%s 字符%s）', dataUrl.length, qrUrl ? `，url=${qrUrl}` : '');
        return { dataUrl, ...(qrUrl ? { qrUrl } : {}) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('提取支付二维码失败（不影响主流程）：%s', message);
        return undefined;
    } finally {
        await page.close().catch(() => undefined);
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
