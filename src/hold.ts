import type { Browser } from 'puppeteer';
import Utility from './Utility.js';
import logger from './logger.js';
import { extractAccountPaymentLink } from './paymentLink.js';
import { capturePaymentQr, type ProxyAuth } from './paymentQr.js';

const ALLOWED_HOLD_MINUTES = new Set([5, 10, 15, 30]);

/** 读取延迟关闭分钟数；兼容 HOLD_MINUTES / LOGIN_HOLD_MINUTES */
export function resolveHoldMinutes(): number {
    const raw = Number(process.env.HOLD_MINUTES || process.env.LOGIN_HOLD_MINUTES || '15');
    return ALLOWED_HOLD_MINUTES.has(raw) ? raw : 15;
}

function webCallbackConfig(): { taskId: string; url: string; secret: string; index: number } | null {
    const taskId = (process.env.WEB_TASK_ID || '').trim();
    const url = (process.env.WEB_CALLBACK_URL || '').trim();
    const secret = (process.env.WEBHOOK_SECRET || '').trim();
    if (!taskId || !url || !secret) return null;
    const index = Number(process.env.WEB_ACCOUNT_INDEX || '0');
    return { taskId, url, secret, index: Number.isInteger(index) ? index : 0 };
}

async function postWebCallback(payload: Record<string, unknown>): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    try {
        const response = await fetch(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Webhook-Secret': config.secret,
                'User-Agent': 'gpt-free-register-web-callback',
            },
            body: JSON.stringify({ taskId: config.taskId, ...payload }),
        });
        if (!response.ok) {
            logger.warn('网页回调失败：HTTP %s', response.status);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('网页回调异常：%s', message);
    }
}

/** 向网页回传友好进度（不含技术细节；失败不影响主流程） */
export async function notifyWebProgress(message: string, email?: string): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const text = message.trim().slice(0, 80);
    if (!text) return;
    await postWebCallback({
        event: 'progress',
        message: text,
        account: {
            index: config.index,
            ...(email ? { email } : {}),
        },
    });
}

/** 成功后回传 access token（可附带支付链接/二维码；holdUntil 可选，提链完成后再传） */
export async function notifyWebAccountSuccess(
    email: string,
    accessToken: string,
    options?: { holdUntil?: number; paymentLink?: string; paymentQr?: string; paymentQrUrl?: string }
): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const holdUntil = options?.holdUntil;
    const paymentLink = options?.paymentLink?.trim();
    const paymentQr = options?.paymentQr?.trim();
    const paymentQrUrl = options?.paymentQrUrl?.trim();
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            accessToken,
            ...(typeof holdUntil === 'number' && holdUntil > 0 ? { holdUntil } : {}),
            ...(paymentLink ? { paymentLink } : {}),
            ...(paymentQr ? { paymentQr } : {}),
            ...(paymentQrUrl ? { paymentQrUrl } : {}),
        },
    });
}

/** 账号已成功后补传支付链接与页面内二维码 */
export async function notifyWebPaymentLink(
    email: string,
    paymentLink: string,
    paymentQr?: string,
    paymentQrUrl?: string,
): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const link = paymentLink.trim();
    if (!link) return;
    const qr = paymentQr?.trim();
    const qrUrl = paymentQrUrl?.trim();
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            paymentLink: link,
            ...(qr ? { paymentQr: qr } : {}),
            ...(qrUrl ? { paymentQrUrl: qrUrl } : {}),
        },
    });
}

/**
 * 顺序：回传 token → 提链 → 打开提链页提取二维码 → 再开始保持等待关闭。
 * 提链/取码不得占用保持时长。
 */
export async function finishAccountSuccess(
    email: string,
    accessToken: string,
    browser?: Browser | null,
    proxyAuth?: ProxyAuth | null,
): Promise<void> {
    // 先回传 token，此时尚未进入保持倒计时
    await notifyWebAccountSuccess(email, accessToken);

    logger.info('登录/注册已成功，进入提链阶段（提链不占用保持时长）');
    const paymentLink = await extractAccountPaymentLink(accessToken, (message) => notifyWebProgress(message, email));
    let paymentQr: string | undefined;
    let paymentQrUrl: string | undefined;
    if (paymentLink) {
        if (browser) {
            logger.info('提链成功，正在打开支付页提取二维码…');
            await notifyWebProgress('正在打开支付页获取二维码…', email);
            const captured = await capturePaymentQr(browser, paymentLink, proxyAuth);
            paymentQr = captured?.dataUrl;
            paymentQrUrl = captured?.qrUrl;
            if (!paymentQr) {
                logger.warn('支付链接已就绪，但二维码提取失败');
                await notifyWebProgress('支付链接已就绪，二维码获取失败', email).catch(() => undefined);
            }
        } else {
            logger.warn('提链成功但无浏览器实例，跳过二维码提取');
        }
        await notifyWebPaymentLink(email, paymentLink, paymentQr, paymentQrUrl);
    } else {
        logger.info('提链阶段未得到支付链接，跳过二维码提取');
    }

    // 提链完成后再开始「等待关闭」
    const holdMinutes = resolveHoldMinutes();
    const holdUntil = Date.now() + holdMinutes * 60 * 1000;
    logger.info('提链阶段结束，即将开始保持等待 %s 分钟', holdMinutes);
    await notifyWebAccountSuccess(email, accessToken, {
        holdUntil,
        ...(paymentLink ? { paymentLink } : {}),
        ...(paymentQr ? { paymentQr } : {}),
        ...(paymentQrUrl ? { paymentQrUrl } : {}),
    });
    await notifyWebProgress(`将保持约 ${holdMinutes} 分钟后关闭…`, email);
    await waitHoldMinutes(holdMinutes, holdUntil);
}

export async function waitHoldMinutes(holdMinutes: number, holdUntil: number): Promise<void> {
    logger.info('开始等待 %s 分钟后退出', holdMinutes);
    while (Date.now() < holdUntil) {
        const remainSec = Math.ceil((holdUntil - Date.now()) / 1000);
        logger.info('保持中，剩余约 %s 秒', remainSec);
        await Utility.waitForSeconds(Math.min(60, remainSec));
    }
    logger.info('等待结束，准备退出');
}
