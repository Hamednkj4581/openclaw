import Utility from './Utility.js';
import logger from './logger.js';
import { extractAccountPaymentLink } from './paymentLink.js';

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

/** 成功后回传 access token（可附带支付链接；holdUntil 可选，提链完成后再传） */
export async function notifyWebAccountSuccess(
    email: string,
    accessToken: string,
    options?: { holdUntil?: number; paymentLink?: string }
): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const holdUntil = options?.holdUntil;
    const paymentLink = options?.paymentLink?.trim();
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            accessToken,
            ...(typeof holdUntil === 'number' && holdUntil > 0 ? { holdUntil } : {}),
            ...(paymentLink ? { paymentLink } : {}),
        },
    });
}

/** 账号已成功后补传支付链接 */
export async function notifyWebPaymentLink(email: string, paymentLink: string): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const link = paymentLink.trim();
    if (!link) return;
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            paymentLink: link,
        },
    });
}

/**
 * 顺序：回传 token → 提链（浏览器仍打开）→ 再开始保持等待关闭。
 * 提链不得占用保持时长。
 */
export async function finishAccountSuccess(email: string, accessToken: string): Promise<void> {
    // 先回传 token，此时尚未进入保持倒计时
    await notifyWebAccountSuccess(email, accessToken);

    const paymentLink = await extractAccountPaymentLink(accessToken, (message) => notifyWebProgress(message, email));
    if (paymentLink) {
        await notifyWebPaymentLink(email, paymentLink);
    }

    // 提链完成后再开始「等待关闭」
    const holdMinutes = resolveHoldMinutes();
    const holdUntil = Date.now() + holdMinutes * 60 * 1000;
    await notifyWebAccountSuccess(email, accessToken, {
        holdUntil,
        ...(paymentLink ? { paymentLink } : {}),
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
