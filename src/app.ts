import './loadEnv.js';
import './patches.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer';
import { authenticator } from 'otplib';
import Utility from './Utility.js';
import logger from './logger.js';
import githubAnnotation from './annotations.js';
import { credentialsFromEnv, preflightMail, waitForMailVerification } from './mailProvider.js';
import { installTurnstileHook, solveCloudflareIfPresent, validateCapSolver } from './capsolver.js';

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const EVIDENCE_TIMEOUT_MS = 15_000;
const VERIFICATION_EMAIL_TIMEOUT_MS = 30_000;
type RegistrationState = 'password' | 'email-verification' | 'code' | 'profile' | 'authenticated' | 'unknown';

function generatePassword(): string {
    return `Gpt!${randomBytes(15).toString('base64url')}9a`;
}

function redactHtml(html: string): string {
    return html
        .replace(/(<input\b[^>]*\b(?:type=["']password["']|name=["'](?:code|otp|token|password)["'])[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
        .replace(/(authorization|refresh_token|access_token|otpSecret)(["'\s:=]+)[^"'\s<]+/gi, '$1$2[REDACTED]');
}

async function withEvidenceTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    return Promise.race([operation, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), EVIDENCE_TIMEOUT_MS))]);
}

async function captureEvidence(page: Page, step: number, stage: string): Promise<void> {
    const safeStage = stage.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    const prefix = `${String(step).padStart(2, '0')}-${safeStage}`;
    fs.mkdirSync('./evidence', { recursive: true });
    logger.info('注册阶段：%s，URL：%s，标题：%s', stage, page.url().replace(/[?#].*$/, ''), await page.title().catch(() => ''));
    const screenshotPath = path.join('./evidence', `${prefix}.png`) as `${string}.png`;
    await withEvidenceTimeout(page.screenshot({ path: screenshotPath, fullPage: true }), '截图').catch(error => logger.warn('证据截图失败：%s', error.message));
    await withEvidenceTimeout(page.content(), 'DOM 快照').then(html => fs.writeFileSync(path.join('./evidence', `${prefix}.html`), redactHtml(html))).catch(error => logger.warn('DOM 快照失败：%s', error.message));
    for (const [index, frame] of page.frames().entries()) {
        if (frame === page.mainFrame() || frame.url() === 'about:blank') continue;
        await withEvidenceTimeout(frame.content(), 'Frame DOM 快照').then(html => fs.writeFileSync(path.join('./evidence', `${prefix}-frame-${index}.html`), redactHtml(html))).catch(error => logger.warn('Frame DOM 快照失败：%s', error.message));
    }
}

async function screenshotAllPages(browser: Browser) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const [index, page] of (await browser.pages()).entries())
        await withEvidenceTimeout(page.screenshot({ path: `./evidence/error-${timestamp}-${index + 1}.png` }), '错误截图').catch(logger.error);
}

async function first(page: Page, selectors: string[]): Promise<ElementHandle<Element> | null> {
    for (const selector of selectors) {
        const element = await page.$x(selector, { timeout: 0 });
        if (element) return element as ElementHandle<Element>;
    }
    return null;
}

async function clickContinue(page: Page): Promise<void> {
    const button = await first(page, [
        "//button[normalize-space(.)='Continue' and not(.//*[contains(translate(normalize-space(.), 'GOOGLE', 'google'), 'google')])]",
        "//button[@type='submit' and not(@disabled)]"
    ]);
    if (!button) throw new Error('找不到可用的非 OAuth Continue/提交按钮');
    await button.click();
}

async function openSignup(page: Page): Promise<void> {
    const button = await first(page, [
        "//button[@data-mobile-auth-entry-action='signup' and not(@disabled)]",
        "//button[contains(normalize-space(string(.)), 'Sign up for free') or normalize-space(string(.))='Sign up']"
    ]);
    if (!button) throw new Error('找不到可用的 ChatGPT 注册入口');
    await button.click();
}

async function detectState(page: Page): Promise<RegistrationState> {
    const url = page.url();
    if (/chatgpt\.com\/(?:\?|$)|chatgpt\.com\/(?:c|g|share)\//i.test(url) && !/auth|login|signup|verify/i.test(url)
        && await first(page, ["//textarea", "//*[@contenteditable='true']", "//button[contains(@aria-label, 'profile') or contains(@data-testid, 'profile')]"])) return 'authenticated';
    if (await first(page, ["//input[@type='password' and not(@disabled)]"])) return 'password';
    if (/\/about-you(?:[/?#]|$)/i.test(url) || await first(page, ["//input[@placeholder='Full name' or @name='name']", "//input[@name='age' or @name='birthday']", "//*[@data-type='month']"])) return 'profile';
    if (await first(page, ["//input[@name='code' or @autocomplete='one-time-code' or @inputmode='numeric']"])) return 'code';
    if (/email-verification/i.test(url) || await first(page, ["//*[contains(translate(normalize-space(.), 'VERIFY YOUR EMAILCHECK YOUR EMAIL', 'verify your emailcheck your email'), 'verify your email') or contains(translate(normalize-space(.), 'VERIFY YOUR EMAILCHECK YOUR EMAIL', 'verify your emailcheck your email'), 'check your email')]"])) return 'email-verification';
    return 'unknown';
}

async function waitForState(page: Page, expected: RegistrationState[], timeoutMs = 60_000): Promise<RegistrationState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await detectState(page);
        if (expected.includes(state)) return state;
        // Cloudflare's managed challenge can appear well after a form submit.
        // Keep looking for it while waiting for the next registration state
        // instead of only checking once immediately after the click.
        await solveCloudflareIfPresent(page, 1);
    }
    return detectState(page);
}

async function setPasswordIfPresent(page: Page, password: string): Promise<boolean> {
    if (await detectState(page) !== 'password') return false;
    await page.type("//input[@type='password' and not(@disabled)]", password);
    await clickContinue(page);
    return true;
}

async function fillProfileIfPresent(page: Page, email: string): Promise<boolean> {
    if (await detectState(page) !== 'profile') return false;
    const fullName = email.split('@')[0].replace(/[^a-zA-Z]/g, '') || 'ChatGPT User';
    if (await first(page, ["//input[@placeholder='Full name' or @name='name']"])) await page.type("//input[@placeholder='Full name' or @name='name']", fullName);
    const ageInput = "//input[@name='age' and not(@disabled)]";
    if (await first(page, [ageInput])) await page.type(ageInput, String(25 + Math.floor(Math.random() * 20)));
    const birthday = { month: String(Math.floor(Math.random() * 12) + 1), day: String(Math.floor(Math.random() * 28) + 1), year: String(1980 + Math.floor(Math.random() * 30)) };
    for (const [type, value] of Object.entries(birthday)) {
        const selector = `//*[@contenteditable='true' and @data-type='${type}'] | //input[@name='${type}']`;
        if (await first(page, [selector])) await page.type(selector, value);
    }
    await clickContinue(page);
    return true;
}

async function enableMfa(page: Page): Promise<string> {
    await page.goto('https://chatgpt.com/#settings/Security');
    await page.click("//button[@aria-label='Multi-factor authentication']");
    await page.click("//span[contains(., 'Trouble scanning?')]");
    const otpSecret = await page.textContent("//button[text()='Copy code']/preceding-sibling::div");
    if (!otpSecret) throw new Error('无法读取 ChatGPT OTP 密钥');
    await page.type("//input[@name='code']", authenticator.generate(otpSecret));
    await clickContinue(page);
    await page.click("//input[@id='safelyRecorded']");
    await clickContinue(page);
    return otpSecret;
}

(async () => {
    let chrome: Browser | undefined;
    let exiting = false;
    let evidenceStep = 0;
    const evidence = (page: Page, stage: string) => captureEvidence(page, ++evidenceStep, stage);
    const fail = async (error: unknown) => {
        if (exiting) return;
        exiting = true;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        githubAnnotation('error', message);
        if (chrome) await screenshotAllPages(chrome);
        await chrome?.close().catch(() => undefined);
        process.exitCode = 1;
    };
    process.once('SIGTERM', () => void fail(new Error('SIGTERM: 终止请求')));
    process.once('unhandledRejection', error => void fail(error));

    try {
        const credentials = credentialsFromEnv();
        const email = credentials.email;
        await validateCapSolver();
        await preflightMail(credentials);
        const registrationStartedAt = new Date(Date.now() - 30_000);
        const enableChatGptMfa = ['1', 'true'].includes(process.env.ENABLE_CHATGPT_MFA ?? '');
        const chatGptPassword = generatePassword();
        chrome = await puppeteer.launch({
            headless: os.platform() === 'linux', defaultViewport: null, protocolTimeout: MAX_TIMEOUT, slowMo: 20,
            handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
            args: ['--lang=en-US', '--window-size=1920,1080', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-zygote', '--disable-gpu']
        });
        logger.info(chrome.process()?.spawnfile, await chrome.version());
        const page = await chrome.newPage();
        await installTurnstileHook(page);
        await page.goto('https://chatgpt.com/');
        await evidence(page, 'chatgpt-opened');
        await solveCloudflareIfPresent(page);
        await evidence(page, 'initial-turnstile-checked');
        await openSignup(page);
        await evidence(page, 'signup-opened');
        await solveCloudflareIfPresent(page);
        await page.type("//input[@name='email' or @type='email']", email, { timeout: 60_000 });
        await evidence(page, 'email-entered');
        await clickContinue(page);
        await solveCloudflareIfPresent(page);

        let state = await waitForState(page, ['password', 'email-verification', 'code', 'profile', 'authenticated']);
        await evidence(page, `after-email-${state}`);
        if (state === 'password') {
            await setPasswordIfPresent(page, chatGptPassword);
            state = await waitForState(page, ['email-verification', 'code', 'profile', 'authenticated']);
            await evidence(page, `after-password-${state}`);
        }
        if (state === 'email-verification' || state === 'code') {
            logger.info('等待 ChatGPT 验证邮件');
            const verification = await waitForMailVerification(credentials, {
                receivedAfter: registrationStartedAt,
                timeoutMs: VERIFICATION_EMAIL_TIMEOUT_MS
            });
            logger.info('收到 ChatGPT 验证邮件，类型：%s', verification.type);
            if (verification.type === 'link') {
                await page.goto(verification.value);
                await solveCloudflareIfPresent(page);
            } else {
                const codeInput = await first(page, ["//input[@name='code' or @autocomplete='one-time-code' or @inputmode='numeric']"]);
                if (!codeInput) throw new Error('收到六位验证码，但当前页面没有验证码输入框');
                await codeInput.type(verification.value);
                await clickContinue(page);
            }
            state = await waitForState(page, ['password', 'profile', 'authenticated']);
            await evidence(page, `after-verification-${state}`);
        }
        if (state === 'password') {
            await setPasswordIfPresent(page, chatGptPassword);
            state = await waitForState(page, ['profile', 'authenticated']);
            await evidence(page, `after-post-verification-password-${state}`);
        }
        if (state === 'profile') {
            await evidence(page, 'profile-form');
            await fillProfileIfPresent(page, email);
            state = await waitForState(page, ['authenticated'], 60_000);
            await evidence(page, `after-profile-${state}`);
        }
        if (state !== 'authenticated') throw new Error(`注册流程未进入已登录 ChatGPT 状态，当前状态：${state}，URL：${page.url().replace(/[?#].*$/, '')}`);
        await evidence(page, 'authenticated');
        const otpSecret = enableChatGptMfa ? await enableMfa(page) : undefined;
        Utility.appendStepSummary(
            [email, chatGptPassword, ...(otpSecret ? [otpSecret] : []), new Date().toString()].join('----')
        );
        logger.info('ChatGPT 注册完成%s', otpSecret ? '，已开启 2FA' : '');
    } catch (error) {
        await fail(error);
    } finally {
        if (!exiting) await chrome?.close().catch(() => undefined);
    }
})();