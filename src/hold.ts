import type { Browser } from 'puppeteer';
import fs from 'fs';
import Utility from './Utility.js';
import logger from './logger.js';
import { submitPaymentQrToGcPh, isGcPhEnabled } from './gcPhOrder.js';
import { extractAccountPaymentLink, isPaymentLinkEnabled } from './paymentLink.js';
import { capturePaymentQr, type ProxyAuth } from './paymentQr.js';

const ALLOWED_HOLD_MINUTES = new Set([0, 5, 10, 15, 30]);
/** 进度文案上限（需容纳提链失败原因） */
const WEB_PROGRESS_MAX = 160;
/** 失败原因上限（需容纳 2FA/已注册等完整说明） */
const WEB_ERROR_MAX = 240;

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

/** 账号失败回传具体原因（失败不影响主流程收尾） */
export async function notifyWebAccountFailure(email: string | undefined, error: string): Promise<void> {
    const tip = error.trim().split(/\r?\n/)[0]?.trim().slice(0, WEB_ERROR_MAX) || '处理失败';
    try {
        fs.writeFileSync('web-account-error.txt', tip, 'utf8');
    } catch {
        // 写文件失败不影响回调
    }
    const config = webCallbackConfig();
    if (!config) return;
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            ...(email ? { email } : {}),
            ok: false,
            error: tip,
        },
    });
    await notifyWebProgress(tip, email).catch(() => undefined);
}

/** 向网页回传进度（失败不影响主流程） */
export async function notifyWebProgress(message: string, email?: string): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const text = message.trim().slice(0, WEB_PROGRESS_MAX);
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

/** 成功后回传 access token（可附带注册密码/2FA、支付链接/二维码图/提链失败原因；holdUntil 可选） */
export async function notifyWebAccountSuccess(
    email: string,
    accessToken: string,
    options?: {
        holdUntil?: number;
        password?: string;
        otpSecret?: string;
        paymentLink?: string;
        paymentQr?: string;
        paymentError?: string;
    }
): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const holdUntil = options?.holdUntil;
    const password = options?.password?.trim();
    const otpSecret = options?.otpSecret?.trim();
    const paymentLink = options?.paymentLink?.trim();
    const paymentQr = options?.paymentQr?.trim();
    const paymentError = options?.paymentError?.trim().slice(0, WEB_PROGRESS_MAX);
    if (process.env.GITHUB_ACTIONS === 'true') {
        if (password) console.log(`::add-mask::${password}`);
        if (otpSecret) console.log(`::add-mask::${otpSecret}`);
        if (accessToken) console.log(`::add-mask::${accessToken}`);
    }
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            accessToken,
            ...(typeof holdUntil === 'number' && holdUntil > 0 ? { holdUntil } : {}),
            ...(password ? { password } : {}),
            ...(otpSecret ? { otpSecret } : {}),
            ...(paymentLink ? { paymentLink } : {}),
            ...(paymentQr ? { paymentQr } : {}),
            ...(paymentError ? { paymentError } : {}),
        },
    });
}

/** 账号已成功后补传支付链接与页面内二维码图片（取码失败时可附带 paymentError） */
export async function notifyWebPaymentLink(
    email: string,
    paymentLink: string,
    paymentQr?: string,
    paymentError?: string,
): Promise<void> {
    const config = webCallbackConfig();
    if (!config) return;
    const link = paymentLink.trim();
    if (!link) return;
    const qr = paymentQr?.trim();
    const tip = paymentError?.trim().slice(0, WEB_PROGRESS_MAX);
    await postWebCallback({
        event: 'account_done',
        account: {
            index: config.index,
            email,
            ok: true,
            paymentLink: link,
            ...(qr ? { paymentQr: qr } : {}),
            ...(tip ? { paymentError: tip } : {}),
        },
    });
}

/**
 * 顺序：回传 token（及可选注册密码/2FA）→ 提链 → 打开提链页提取二维码 → 再开始保持等待关闭。
 * 提链/取码不得占用保持时长；取码成功后支付页保持打开，等保持时长到再随浏览器退出。
 */
export async function finishAccountSuccess(
    email: string,
    accessToken: string,
    browser?: Browser | null,
    proxyAuth?: ProxyAuth | null,
    credentials?: { password?: string; otpSecret?: string },
): Promise<void> {
    const password = credentials?.password?.trim();
    const otpSecret = credentials?.otpSecret?.trim();
    // 先回传 token/凭据，此时尚未进入保持倒计时
    await notifyWebAccountSuccess(email, accessToken, {
        ...(password ? { password } : {}),
        ...(otpSecret ? { otpSecret } : {}),
    });

    logger.info('登录/注册已成功，进入提链阶段（提链不占用保持时长）');
    if (isPaymentLinkEnabled()) {
        await notifyWebProgress('账号已就绪，正在处理支付提链…', email).catch(() => undefined);
    }
    const payment = await extractAccountPaymentLink(accessToken, (message) => notifyWebProgress(message, email));
    const paymentLink = payment.link;
    let paymentError = payment.error;
    let paymentQr: string | undefined;
    if (paymentLink) {
        if (browser) {
            logger.info('提链成功，正在打开支付页提取二维码图片…');
            await notifyWebProgress('正在打开支付页获取二维码…', email);
            const captured = await capturePaymentQr(browser, paymentLink, proxyAuth);
            paymentQr = captured?.dataUrl;
            if (!paymentQr) {
                paymentError = captured?.error?.trim()
                    || '支付链接已就绪，但二维码获取失败';
                logger.warn(paymentError);
                await notifyWebProgress(paymentError, email).catch(() => undefined);
            } else {
                await notifyWebProgress('支付二维码已就绪', email).catch(() => undefined);
            }
        } else {
            paymentError = '支付链接已就绪，但二维码获取失败';
            logger.warn('提链成功但无浏览器实例，跳过二维码提取');
            await notifyWebProgress(paymentError, email).catch(() => undefined);
        }
        // 先回传链接/二维码图，再走菲律宾通道（轮询可能较长，避免网页迟迟看不到码）
        await notifyWebPaymentLink(email, paymentLink, paymentQr, paymentQr ? undefined : paymentError);
        if (paymentQr && isGcPhEnabled()) {
            await submitPaymentQrToGcPh(paymentQr, (message) => notifyWebProgress(message, email));
        } else if (paymentQr) {
            logger.info('未传 GC_PH_API_KEY，跳过菲律宾通道提图');
        }
    } else if (paymentError) {
        logger.info('提链未完成：%s', paymentError);
        await notifyWebProgress(paymentError, email).catch(() => undefined);
    } else {
        logger.info('提链阶段未启用或未得到支付链接，跳过二维码提取');
    }

    // 提链完成后再开始「等待关闭」；paymentError 单独落库，不被保持提示覆盖
    const holdMinutes = resolveHoldMinutes();
    const holdUntil = holdMinutes > 0 ? Date.now() + holdMinutes * 60 * 1000 : 0;
    logger.info('提链阶段结束，即将开始保持等待 %s 分钟', holdMinutes);
    await notifyWebAccountSuccess(email, accessToken, {
        ...(holdUntil > 0 ? { holdUntil } : {}),
        ...(password ? { password } : {}),
        ...(otpSecret ? { otpSecret } : {}),
        ...(paymentLink ? { paymentLink } : {}),
        ...(paymentQr ? { paymentQr } : {}),
        ...(paymentError ? { paymentError } : {}),
    });
    if (holdMinutes > 0) {
        await notifyWebProgress(`将保持约 ${holdMinutes} 分钟后关闭…`, email);
        await waitHoldMinutes(holdMinutes, holdUntil);
        await notifyWebProgress('保持结束，正在关闭…', email).catch(() => undefined);
    } else {
        await notifyWebProgress('即将关闭…', email);
        logger.info('保持时长为 0，跳过等待直接退出');
    }
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
