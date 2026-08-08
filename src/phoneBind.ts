import type { ElementHandle, Page } from 'puppeteer';
import Utility from './Utility.js';
import logger from './logger.js';
import {
    HeroSmsError,
    cancelHeroSmsActivation,
    completeHeroSmsActivation,
    heroSmsCountry,
    heroSmsService,
    isHeroSmsConfigured,
    markHeroSmsReady,
    maskPhoneNumber,
    requestHeroSmsNumber,
    waitHeroSmsCode,
} from './heroSms.js';
import {
    MFA_CODE_SELECTORS,
    MFA_SMS_ENABLED_SELECTORS,
    MFA_VERIFY_SELECTORS,
    PHONE_INPUT_SELECTORS,
    PHONE_SEND_CODE_SELECTORS,
} from './selectors.js';

/** 绑定失败时换号重试次数（固定，网页端不配置） */
const PHONE_BIND_MAX_RETRIES = 3;

export type PhoneBindResult = {
    phoneNumber?: string;
    error?: string;
};

type EvidenceFn = (page: Page, stage: string) => Promise<void>;
type ProgressFn = (message: string) => Promise<void>;

async function first(page: Page, selectors: string[]): Promise<ElementHandle<Element> | null> {
    for (const selector of selectors) {
        const handle = await page.$(`xpath/${selector}`).catch(() => null);
        if (handle) return handle;
    }
    return null;
}

/** 关闭 You're all set 引导层，避免挡住设置页 */
async function dismissYoureAllSetIfPresent(page: Page): Promise<void> {
    const closeButton = await first(page, [
        "//*[@aria-modal='true'][.//*[normalize-space(.)=\"You're all set\"]]//button[@aria-label='Close' or @aria-label='Dismiss']",
        "//*[@aria-modal='true'][.//*[normalize-space(.)=\"You're all set\"]]//button[contains(normalize-space(.), 'Continue')]"
    ]);
    if (closeButton) await closeButton.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
}

export function isBindPhoneMode(): boolean {
    return (process.env.TASK_MODE || '').trim().toLowerCase() === 'bind_phone';
}

export function isPhoneBindEnabled(): boolean {
    return isBindPhoneMode() && isHeroSmsConfigured();
}

function apiKey(): string {
    return (process.env.HERO_SMS_API_KEY || '').trim();
}

function digitsOnly(value: string): string {
    return value.replace(/\D/g, '');
}

async function typePhoneNumber(page: Page, phoneNumber: string): Promise<void> {
    const input = await Utility.waitForFunction(
        () => first(page, PHONE_INPUT_SELECTORS),
        { timeout: 45_000 },
    );
    const digits = digitsOnly(phoneNumber);
    await input.click({ clickCount: 3 }).catch(() => undefined);
    await input.type(digits, { delay: 20 });
}

async function clickSendCode(page: Page): Promise<void> {
    const button = await Utility.waitForFunction(
        () => first(page, PHONE_SEND_CODE_SELECTORS),
        { timeout: 30_000 },
    );
    await button.evaluate((el) => (el as HTMLElement).click());
}

async function submitSmsCode(page: Page, code: string): Promise<void> {
    const input = await Utility.waitForFunction(
        () => first(page, MFA_CODE_SELECTORS),
        { timeout: 45_000 },
    );
    await input.click({ clickCount: 3 }).catch(() => undefined);
    await input.type(code, { delay: 20 });
    const verifyButton = await Utility.waitForFunction(
        () => first(page, MFA_VERIFY_SELECTORS),
        { timeout: 30_000 },
    );
    await verifyButton.evaluate((el) => (el as HTMLElement).click());
}

/** 在 ChatGPT 安全设置中开启短信 MFA 并绑定号码 */
async function bindPhoneOnce(
    page: Page,
    evidence: EvidenceFn | undefined,
    onProgress: ProgressFn,
): Promise<string> {
    const key = apiKey();
    const service = heroSmsService();
    const country = heroSmsCountry();
    if (!key || !service || country === null) {
        throw new HeroSmsError('Hero SMS 配置不完整');
    }

    await dismissYoureAllSetIfPresent(page);
    await page.goto('https://chatgpt.com/#settings/Security', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissYoureAllSetIfPresent(page);
    await evidence?.(page, 'phone-bind-security');

    if (await first(page, MFA_SMS_ENABLED_SELECTORS)) {
        throw new HeroSmsError('ChatGPT 短信验证已启用，无法重复绑定');
    }

    const smsToggle = await Utility.waitForFunction(async () => {
        await dismissYoureAllSetIfPresent(page);
        return first(page, [
            "//button[@data-testid='mfa-sms-toggle' and @role='switch']",
            "//button[@role='switch' and contains(translate(@aria-label, 'TEXT MESSAGE', 'text message'), 'text message')]",
            "//*[contains(translate(normalize-space(.), 'TEXT MESSAGE', 'text message'), 'text message') or contains(translate(normalize-space(.), 'WHATSAPP', 'whatsapp'), 'whatsapp')]/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']"
        ]);
    }, { timeout: 60_000 });

    await onProgress('正在从 Hero SMS 获取手机号…');
    const number = await requestHeroSmsNumber(key, service, country);
    logger.info('Hero SMS 已取号：activation=%s phone=%s', number.activationId, maskPhoneNumber(number.phoneNumber));
    await markHeroSmsReady(key, number.activationId);

    await smsToggle.evaluate((el) => (el as HTMLElement).click());
    await evidence?.(page, 'phone-bind-toggle');

    await typePhoneNumber(page, number.phoneNumber);
    await evidence?.(page, 'phone-bind-number');
    await clickSendCode(page);
    await onProgress('已发送短信验证码，等待接码…');

    let code: string;
    try {
        code = await waitHeroSmsCode(key, number.activationId);
    } catch (error) {
        await cancelHeroSmsActivation(key, number.activationId);
        throw error;
    }

    await submitSmsCode(page, code);
    await Utility.waitForFunction(
        () => first(page, MFA_SMS_ENABLED_SELECTORS),
        { timeout: 60_000 },
    );
    await completeHeroSmsActivation(key, number.activationId);
    await evidence?.(page, 'phone-bind-done');
    return number.phoneNumber;
}

/**
 * 换号重试绑定；全部失败后返回 error，不抛出。
 * 重试过程通过 onProgress 回传友好文案。
 */
export async function bindPhoneWithRetry(
    page: Page,
    onProgress: ProgressFn = async () => undefined,
    evidence?: EvidenceFn,
): Promise<PhoneBindResult> {
    if (!isPhoneBindEnabled()) return { error: '未启用手机号绑定' };
    let lastError = '手机号绑定失败';

    for (let attempt = 1; attempt <= PHONE_BIND_MAX_RETRIES; attempt++) {
        try {
            if (attempt > 1) {
                await onProgress(`换号重试绑定（第 ${attempt}/${PHONE_BIND_MAX_RETRIES} 次）…`);
            } else {
                await onProgress('正在绑定手机号…');
            }
            const phoneNumber = await bindPhoneOnce(page, evidence, onProgress);
            await onProgress(`手机号已绑定（${maskPhoneNumber(phoneNumber)}）`);
            return { phoneNumber };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            logger.warn('手机号绑定失败（%s/%s）：%s', attempt, PHONE_BIND_MAX_RETRIES, lastError);
            if (attempt < PHONE_BIND_MAX_RETRIES) {
                await onProgress('本次绑定未成功，准备换号重试…');
            }
        }
    }

    await onProgress(`手机号绑定未成功：${lastError.slice(0, 80)}`);
    return { error: lastError };
}
