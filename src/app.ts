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
import { installNetworkCapture } from './networkCapture.js';
import { buildJapanStickyProxy, buildProxyPacUrl, preflightProxy } from './proxy.js';
import { MFA_CHALLENGE_SELECTORS, MFA_CODE_SELECTORS, MFA_ENABLED_SELECTORS, MFA_VERIFY_SELECTORS, SIGNUP_EMAIL_SELECTORS, SIGNUP_SELECTORS } from './selectors.js';

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const EVIDENCE_TIMEOUT_MS = 15_000;
const VERIFICATION_EMAIL_TIMEOUT_MS = 30_000;
type RegistrationState = 'password' | 'email-verification' | 'code' | 'profile' | 'authenticated' | 'mfa-challenge' | 'unknown';
const sensitiveValues = new Set<string>();

function generatePassword(): string {
    return `Gpt!${randomBytes(15).toString('base64url')}9a`;
}

function redactHtml(html: string): string {
    let redacted = html
        .replace(/(<input\b[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
        .replace(/(<input\b[^>]*\b(?:type=["']password["']|name=["'](?:code|otp|token|password)["'])[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
        .replace(/(authorization|refresh_token|access_token|accessToken|otpSecret)(["'\s:=]+)[^"'\s<]+/gi, '$1$2[REDACTED]');
    for (const value of sensitiveValues)
        if (value) redacted = redacted.replaceAll(value, '[REDACTED]');
    return redacted;
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

async function captureErrorEvidence(browser: Browser) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync('./evidence', { recursive: true });
    for (const [index, page] of (await browser.pages()).entries()) {
        const prefix = `error-${timestamp}-${index + 1}`;
        await withEvidenceTimeout(page.screenshot({ path: `./evidence/${prefix}.png`, fullPage: true }), '错误截图').catch(error => logger.warn('错误截图失败：%s', error.message));
        await withEvidenceTimeout(page.content(), '错误 DOM 快照').then(html => fs.writeFileSync(`./evidence/${prefix}.html`, redactHtml(html))).catch(error => logger.warn('错误 DOM 快照失败：%s', error.message));
        for (const [frameIndex, frame] of page.frames().entries()) {
            if (frame === page.mainFrame() || frame.url() === 'about:blank') continue;
            await withEvidenceTimeout(frame.content(), '错误 Frame DOM 快照').then(html => fs.writeFileSync(`./evidence/${prefix}-frame-${frameIndex}.html`, redactHtml(html))).catch(error => logger.warn('错误 Frame DOM 快照失败：%s', error.message));
        }
    }
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

/** 点击注册入口并等待邮箱弹层；首页慢加载/水合未完成时单次 click 可能无效，故重试。 */
async function openSignup(page: Page): Promise<void> {
    if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;

    const deadline = Date.now() + 60_000;
    let lastError = '';
    while (Date.now() < deadline) {
        if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;

        const button = await first(page, SIGNUP_SELECTORS);
        if (!button) {
            lastError = '未找到 Sign up 按钮';
            await Utility.waitForSeconds(0.5);
            continue;
        }

        try {
            await button.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
            const box = await button.boundingBox();
            // 优先坐标点击，避免 React 水合后 ElementHandle.click 偶发不触发
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            else await button.click();
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            await Utility.waitForSeconds(0.5);
            continue;
        }

        const opened = await Utility.waitForFunction(
            () => first(page, SIGNUP_EMAIL_SELECTORS),
            { pollInterval: 400, timeout: 8_000 }
        ).catch(() => null);
        if (opened) return;
        lastError = '已点击 Sign up，但邮箱输入框未出现';
    }

    const title = await page.title().catch(() => '');
    throw new Error(`打开 ChatGPT 注册入口超时（${lastError || '未知'}），URL：${page.url().replace(/[?#].*$/, '')}，标题：${title}`);
}

/** 识别 chrome-error 导航失败，避免误判为 unknown / 被 Protocol error 掩盖。 */
async function chromeNavigationFailure(page: Page): Promise<string | null> {
    const url = page.url();
    if (!/^chrome-error:\/\//i.test(url)) return null;
    const html = await page.content().catch(() => '');
    const matchedCode = html.match(/\bERR_[A-Z0-9_]+\b/)?.[0];
    const fallbackCode = matchedCode ?? await page.evaluate(() => {
        const raw = (globalThis as { loadTimeDataRaw?: { errorCode?: string } }).loadTimeDataRaw;
        return raw?.errorCode ?? document.querySelector('.error-code')?.textContent?.trim() ?? '';
    }).catch(() => '');
    const code = fallbackCode || 'UNKNOWN';
    const targetRaw = html.match(/The webpage at <strong>([^<]+)<\/strong>/i)?.[1]
        ?? html.match(/https?:\/\/[^\s"'<>]+/i)?.[0]
        ?? '';
    const target = targetRaw.replace(/&amp;/g, '&').replace(/[?#].*$/, '');
    if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(code))
        return `代理隧道连接失败（${code}）：无法打开 ${target || '目标站点'}，页面已落到 chrome-error。这通常是 711Proxy 不稳定，不是注册选择器或 Protocol error。`;
    return `浏览器导航失败（${code}）：无法打开 ${target || '目标站点'}，页面已落到 chrome-error。请检查代理/网络。`;
}

async function assertNoChromeNavigationFailure(page: Page): Promise<void> {
    const message = await chromeNavigationFailure(page);
    if (message) throw new Error(message);
}

async function detectState(page: Page): Promise<RegistrationState> {
    const url = page.url();
    // chrome-error 上继续查选择器会触发 Puppeteer world 错乱，先短路。
    if (/^chrome-error:\/\//i.test(url)) return 'unknown';
    // 注册弹层仍可能停在 chatgpt.com，且页面上有 textarea/contenteditable；有邮箱输入框时不算已登录。
    if (/chatgpt\.com\/(?:\?|$)|chatgpt\.com\/(?:c|g|share)\//i.test(url) && !/auth|login|signup|verify/i.test(url)
        && !await first(page, SIGNUP_EMAIL_SELECTORS)
        && await first(page, [
            "//textarea[@id='prompt-textarea' or contains(@placeholder, 'Ask') or contains(@placeholder, 'Message')]",
            "//*[@contenteditable='true' and (@id='prompt-textarea' or contains(@data-testid, 'composer') or contains(@placeholder, 'Ask') or contains(@placeholder, 'Message'))]",
            "//button[contains(@aria-label, 'profile') or contains(@data-testid, 'profile')]"
        ])) return 'authenticated';
    if (await first(page, ["//input[@type='password' and not(@disabled)]"])) return 'password';
    if (/\/about-you(?:[/?#]|$)/i.test(url) || await first(page, ["//input[@placeholder='Full name' or @name='name']", "//input[@name='age' or @name='birthday']", "//*[@data-type='month']"])) return 'profile';
    if (/\/mfa-challenge(?:[/?#]|$)/i.test(url) || await first(page, MFA_CHALLENGE_SELECTORS)) return 'mfa-challenge';
    if (await first(page, ["//input[@name='code' or @autocomplete='one-time-code' or @inputmode='numeric']"])) return 'code';
    if (/email-verification/i.test(url) || await first(page, ["//*[contains(translate(normalize-space(.), 'VERIFY YOUR EMAILCHECK YOUR EMAIL', 'verify your emailcheck your email'), 'verify your email') or contains(translate(normalize-space(.), 'VERIFY YOUR EMAILCHECK YOUR EMAIL', 'verify your emailcheck your email'), 'check your email')]"])) return 'email-verification';
    return 'unknown';
}

async function waitForState(page: Page, expected: RegistrationState[], timeoutMs = 60_000): Promise<RegistrationState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await assertNoChromeNavigationFailure(page);
        const state = await detectState(page);
        if (state === 'mfa-challenge')
            throw new Error('检测到已有 OpenAI 账号的两步验证（2FA）挑战：该邮箱已注册并启用了验证器 MFA，需要原账号的动态验证码；请关闭原账号 2FA 后重试，或更换未注册过 OpenAI 的邮箱。');
        if (expected.includes(state)) return state;
        // Cloudflare's managed challenge can appear well after a form submit.
        // Keep looking for it while waiting for the next registration state
        // instead of only checking once immediately after the click.
        await solveCloudflareIfPresent(page, 1);
    }
    await assertNoChromeNavigationFailure(page);
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

async function extractAccessToken(page: Page): Promise<string> {
    return Utility.waitForFunction(async () => {
        try {
            const accessToken = await page.evaluate(async () => {
                const response = await fetch('/api/auth/session', { credentials: 'include' });
                if (!response.ok)
                    throw new Error(`session HTTP ${response.status}`);
                const data = await response.json() as { accessToken?: unknown };
                return typeof data.accessToken === 'string' && data.accessToken ? data.accessToken : null;
            });
            return accessToken;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/session HTTP/i.test(message)) return null;
            throw new Error(`提取 ChatGPT accessToken 失败：${message}`);
        }
    }, { pollInterval: 500, timeout: 30_000 }).catch(() => {
        throw new Error('已登录但 /api/auth/session 未返回 accessToken');
    });
}

async function enableMfa(page: Page, evidence: (page: Page, stage: string) => Promise<void>): Promise<string> {
    await page.goto('https://chatgpt.com/#settings/Security');
    const authenticatorToggle = await Utility.waitForFunction(() => first(page, [
        "//button[@aria-label='Multi-factor authentication']",
        "//button[@role='switch' and contains(translate(@aria-label, 'AUTHENTICATOR', 'authenticator'), 'authenticator')]",
        "//*[normalize-space(.)='Authenticator app']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']"
    ]), { timeout: 30_000 });
    await evidence(page, 'mfa-security-settings');
    if (await first(page, MFA_ENABLED_SELECTORS))
        throw new Error('ChatGPT 验证器 MFA 已启用，无法重新读取现有 OTP 密钥；已保留当前 MFA 设置');
    await authenticatorToggle.click();
    const troubleScanning = await Utility.waitForFunction(() => first(page, [
        "//*[self::button or self::span or self::a][contains(normalize-space(.), 'Trouble scanning?')]",
        "//*[self::button or self::a][contains(normalize-space(.), 'setup key') or contains(normalize-space(.), 'Setup key')]"
    ]), { timeout: 30_000 });
    await troubleScanning.click();
    const otpSecretElement = await Utility.waitForFunction(() => first(page, [
        "//button[normalize-space(.)='Copy code']/preceding-sibling::*[1]",
        "//*[contains(normalize-space(.), 'setup key')]/following::*[self::code or self::div][normalize-space(.)][1]"
    ]), { timeout: 30_000 });
    const otpSecret = (await otpSecretElement.evaluate(element => element.textContent) ?? '').replace(/\s+/g, '');
    if (!otpSecret) throw new Error('无法读取 ChatGPT OTP 密钥');
    sensitiveValues.add(otpSecret);
    await evidence(page, 'mfa-secret-ready');
    const codeInput = await Utility.waitForFunction(
        () => first(page, MFA_CODE_SELECTORS),
        { timeout: 30_000 }
    );
    await codeInput.type(authenticator.generate(otpSecret));
    const verifyButton = await Utility.waitForFunction(
        () => first(page, MFA_VERIFY_SELECTORS),
        { timeout: 30_000 }
    );
    await verifyButton.click();
    const nextStep = await Utility.waitForFunction(async () => {
        const enabledToggle = await first(page, MFA_ENABLED_SELECTORS);
        if (enabledToggle) return { enabledToggle };
        const safelyRecorded = await first(page, [
            "//input[@id='safelyRecorded' or @type='checkbox']",
            "//button[@role='checkbox']"
        ]);
        return safelyRecorded ? { safelyRecorded } : null;
    }, { timeout: 30_000 });
    if ('safelyRecorded' in nextStep) {
        await nextStep.safelyRecorded.click();
        await clickContinue(page);
        await Utility.waitForFunction(() => first(page, MFA_ENABLED_SELECTORS), { timeout: 30_000 });
    }
    await evidence(page, 'mfa-enabled');
    return otpSecret;
}

(async () => {
    let chrome: Browser | undefined;
    let exiting = false;
    let evidenceStep = 0;
    let networkCapture: ReturnType<typeof installNetworkCapture> | undefined;
    const redactText = (text: string) => {
        let out = text;
        for (const value of sensitiveValues)
            if (value) out = out.replaceAll(value, '[REDACTED]');
        return out;
    };
    const evidence = (page: Page, stage: string) => captureEvidence(page, ++evidenceStep, stage);
    const fail = async (error: unknown) => {
        if (exiting) return;
        exiting = true;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        githubAnnotation('error', message);
        networkCapture?.flush();
        if (chrome) await captureErrorEvidence(chrome);
        await chrome?.close().catch(() => undefined);
        process.exitCode = 1;
    };
    process.once('SIGTERM', () => void fail(new Error('SIGTERM: 终止请求')));
    process.once('unhandledRejection', error => void fail(error));

    try {
        const credentials = credentialsFromEnv();
        const email = credentials.email;
        Object.values(credentials).forEach(value => typeof value === 'string' && sensitiveValues.add(value));
        await validateCapSolver();
        await preflightMail(credentials);
        const proxy = buildJapanStickyProxy();
        sensitiveValues.add(proxy.password);
        sensitiveValues.add(process.env.PROXY_USERNAME ?? '');
        await preflightProxy(proxy);
        logger.info('711Proxy 预检通过：%s region=%s session=%s sessTime=%smin（PAC：静态资源直连，其余走代理）', proxy.server, proxy.region, proxy.session, proxy.sessTime);
        const registrationStartedAt = new Date(Date.now() - 30_000);
        const enableChatGptMfa = ['1', 'true'].includes((process.env.ENABLE_CHATGPT_MFA ?? 'true').toLowerCase());
        const chatGptPassword = generatePassword();
        chrome = await puppeteer.launch({
            headless: os.platform() === 'linux', defaultViewport: null, protocolTimeout: MAX_TIMEOUT, slowMo: 20,
            handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
            args: [
                // PAC：静态资源直连，HTML/接口走日本代理（page.authenticate 仍作用于代理请求）
                `--proxy-pac-url=${buildProxyPacUrl(proxy)}`,
                '--lang=en-US', '--window-size=1920,1080', '--disable-blink-features=AutomationControlled',
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-zygote', '--disable-gpu'
            ]
        });
        logger.info(chrome.process()?.spawnfile, await chrome.version());
        const page = await chrome.newPage();
        await page.authenticate({ username: proxy.username, password: proxy.password });
        // 抓取全程 URL 写入 evidence，供分析哪些主机/资源不必走住宅代理
        networkCapture = installNetworkCapture(page, redactText);
        await installTurnstileHook(page);
        await page.goto('https://chatgpt.com/');
        await evidence(page, 'chatgpt-opened');
        await solveCloudflareIfPresent(page);
        await evidence(page, 'initial-turnstile-checked');
        await openSignup(page);
        await evidence(page, 'signup-opened');
        await solveCloudflareIfPresent(page);
        await page.type(SIGNUP_EMAIL_SELECTORS[0], email, { timeout: 60_000 });
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
                timeoutMs: credentials.provider === 'outlook' ? VERIFICATION_EMAIL_TIMEOUT_MS : 90_000
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
        if (state !== 'authenticated') {
            await assertNoChromeNavigationFailure(page);
            throw new Error(`注册流程未进入已登录 ChatGPT 状态，当前状态：${state}，URL：${page.url().replace(/[?#].*$/, '')}`);
        }
        await evidence(page, 'authenticated');
        const otpSecret = enableChatGptMfa ? await enableMfa(page, evidence) : undefined;
        const accessToken = await extractAccessToken(page);
        sensitiveValues.add(accessToken);
        await evidence(page, 'access-token-ready');
        Utility.appendStepSummary(
            [email, chatGptPassword, ...(otpSecret ? [otpSecret] : []), accessToken, new Date().toString()].join('----')
        );
        logger.info('ChatGPT 注册完成%s，已提取 accessToken', otpSecret ? '，已开启 2FA' : '');
    } catch (error) {
        await fail(error);
    } finally {
        networkCapture?.flush();
        if (!exiting) await chrome?.close().catch(() => undefined);
    }
})();