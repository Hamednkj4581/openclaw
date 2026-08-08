import Utility from './Utility.js';
import logger from './logger.js';

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

/** 成功后先回传网页，再进入保持等待 */
export async function notifyWebAccountSuccess(email: string, accessToken: string, holdUntil: number): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            accessToken,
            holdUntil,
        },
    });
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
