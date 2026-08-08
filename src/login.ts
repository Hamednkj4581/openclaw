import './loadEnv.js';
import './patches.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer';
import { authenticator } from 'otplib';
import Utility from './Utility.js';
import logger from './logger.js';
import githubAnnotation from './annotations.js';
import { installTurnstileHook, solveCloudflareIfPresent, validateCapSolver } from './capsolver.js';
import { installNetworkCapture } from './networkCapture.js';
import { buildJapanStickyProxy, buildProxyPacUrl, is711ProxyEnabled, preflightProxy, rotateStickySession } from './proxy.js';
import {
    AUTHENTICATED_SELECTORS,
    CONTINUE_SELECTORS,
    LOGIN_SELECTORS,
    MFA_CHALLENGE_SELECTORS,
    MFA_CODE_SELECTORS,
    MFA_VERIFY_SELECTORS,
    SIGNUP_EMAIL_SELECTORS,
    SIGNUP_SELECTORS,
} from './selectors.js';
import { parseLoginAccount } from './loginAccount.js';
import { notifyWebAccountSuccess, resolveHoldMinutes, waitHoldMinutes } from './hold.js';

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const EVIDENCE_TIMEOUT_MS = 15_000;
const MAX_OPEN_CHATGPT_ATTEMPTS = 3;

type LoginState = 'email' | 'password' | 'mfa-challenge' | 'authenticated' | 'unknown';

const sensitiveValues = new Set<string>();

function redactHtml(html: string): string {
    let redacted = html
        .replace(/(<input\b[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
        .replace(/(authorization|refresh_token|access_token|accessToken|sessionToken|otpSecret)(["'\s:=]+)[^"'\s<]+/gi, '$1$2[REDACTED]');
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
    logger.info('登录阶段：%s，URL：%s，标题：%s', stage, page.url().replace(/[?#].*$/, ''), await page.title().catch(() => ''));
    const screenshotPath = path.join('./evidence', `${prefix}.png`) as `${string}.png`;
    await withEvidenceTimeout(page.screenshot({ path: screenshotPath, fullPage: true }), '截图').catch(error => logger.warn('证据截图失败：%s', error.message));
    await withEvidenceTimeout(page.content(), 'DOM 快照').then(html => fs.writeFileSync(path.join('./evidence', `${prefix}.html`), redactHtml(html))).catch(error => logger.warn('DOM 快照失败：%s', error.message));
}

async function captureErrorEvidence(browser: Browser) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync('./evidence', { recursive: true });
    for (const [index, page] of (await browser.pages()).entries()) {
        const prefix = `error-${timestamp}-${index + 1}`;
        await withEvidenceTimeout(page.screenshot({ path: `./evidence/${prefix}.png`, fullPage: true }), '错误截图').catch(error => logger.warn('错误截图失败：%s', error.message));
        await withEvidenceTimeout(page.content(), '错误 DOM 快照').then(html => fs.writeFileSync(`./evidence/${prefix}.html`, redactHtml(html))).catch(error => logger.warn('错误 DOM 快照失败：%s', error.message));
    }
}

async function first(page: Page, selectors: string[]): Promise<ElementHandle<Element> | null> {
    for (const selector of selectors) {
        try {
            const elements = await page.mainFrame().$$(selector) as ElementHandle<Element>[];
            for (const element of elements) {
                if (await element.isVisible().catch(() => false))
                    return element;
            }
        } catch (error) {
            if (Utility.isStaleExecutionContextError(error)) continue;
            throw error;
        }
    }
    return null;
}

/** 等待邮箱表单完成 React 水合，避免 Continue 变成 /auth/login?email= 刷新 */
async function waitForEmailFormReady(page: Page, timeoutMs = 30_000): Promise<void> {
    await Utility.waitForFunction(async () => {
        const ready = await page.evaluate(() => {
            const email = document.querySelector(
                '#mobile-auth-email, #email, input[name="email"], input[name="login_hint"], input[type="email"]'
            ) as HTMLInputElement | null;
            if (!email) return null;
            const form = email.closest('form');
            if (!form) return null;
            const dialog = form.closest('dialog') as HTMLDialogElement | null;
            if (dialog && !(dialog.open || dialog.hasAttribute('open'))) return null;
            const hydrated = (el: Element) => Object.keys(el).some(key =>
                key.startsWith('__reactFiber')
                || key.startsWith('__reactProps')
                || key.startsWith('__reactInternalInstance'));
            return (hydrated(form) || hydrated(email)) ? true : null;
        }).catch(() => null);
        return ready;
    }, { pollInterval: 300, timeout: timeoutMs }).catch(() => {
        throw new Error('登录邮箱表单未完成 React 水合，继续提交只会触发原生刷新');
    });
}

/** 写入受控邮箱输入：键盘输入 + 原生 value setter，确保 React state 同步 */
async function fillEmailInput(page: Page, email: string): Promise<void> {
    const emailInput = await first(page, SIGNUP_EMAIL_SELECTORS);
    if (!emailInput) throw new Error('登录邮箱输入框不可见');
    await emailInput.click({ clickCount: 3 }).catch(() => undefined);
    await page.keyboard.press('Backspace').catch(() => undefined);
    await emailInput.type(email, { delay: 15 });
    await emailInput.evaluate((el, value) => {
        const input = el as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, email);
}

async function clickContinue(page: Page): Promise<void> {
    const beforeUrl = page.url();
    // 优先点邮箱表单的 submit；禁止 form.submit()（会绕过 React onSubmit，经典页会 GET 刷新）
    const formSubmitted = await page.evaluate(() => {
        const provider = document.querySelector('form[data-auth-provider="email"]') as HTMLFormElement | null;
        let form: HTMLFormElement | null = null;
        if (provider) {
            const dialog = provider.closest('dialog') as HTMLDialogElement | null;
            if (!dialog || dialog.open || dialog.hasAttribute('open')) form = provider;
        }
        if (!form) {
            const email = document.querySelector(
                '#mobile-auth-email, #email, input[name="email"], input[name="login_hint"], input[type="email"]'
            ) as HTMLInputElement | null;
            form = email?.closest('form') as HTMLFormElement | null;
        }
        if (!form) return false;
        const submit = form.querySelector(
            'button[type="submit"]:not([disabled]), button.emailButton[type="submit"]:not([disabled])'
        ) as HTMLButtonElement | null;
        if (submit) {
            submit.click();
            return true;
        }
        if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return true;
        }
        return false;
    }).catch(() => false);
    if (formSubmitted) return;

    const button = await first(page, CONTINUE_SELECTORS);
    if (!button) throw new Error('找不到可用的非 OAuth Continue/提交按钮');
    try {
        const box = await button.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        else await button.evaluate(el => (el as HTMLElement).click());
    } catch (error) {
        if (page.url() !== beforeUrl && Utility.isStaleExecutionContextError(error))
            return;
        throw error;
    }
}

/** bottom-sheet login_with 表单提交失败时，按表单字段拼 GET 跳转 */
async function navigateLoginWithFallback(page: Page, email: string): Promise<boolean> {
    const target = await page.evaluate((emailValue) => {
        const form = document.querySelector('form[data-auth-provider="email"]') as HTMLFormElement | null;
        if (!form?.action || !/login_with/i.test(form.action)) return '';
        const params = new URLSearchParams();
        const hint = (form.querySelector('#mobile-auth-email, input[name="login_hint"]') as HTMLInputElement | null)?.value
            || emailValue;
        params.set('login_hint', hint);
        for (const name of ['callback_path', 'screen_hint']) {
            const hidden = form.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
            if (hidden?.value) params.set(name, hidden.value);
        }
        return `${form.action.split('?')[0]}?${params.toString()}`;
    }, email).catch(() => '');
    if (!target) return false;
    logger.info('邮箱 Continue 未前进，改走 login_with 跳转兜底');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000, retries: 2 });
    return true;
}

async function chromeNavigationFailure(page: Page): Promise<string | null> {
    const url = page.url();
    if (!/^chrome-error:\/\//i.test(url)) return null;
    const html = await page.content().catch(() => '');
    const matchedCode = html.match(/\bERR_[A-Z0-9_]+\b/)?.[0];
    const code = matchedCode || 'UNKNOWN';
    return `浏览器导航失败（${code}）：无法打开目标站点，页面已落到 chrome-error。请检查代理/网络。`;
}

async function assertNoChromeNavigationFailure(page: Page): Promise<void> {
    const message = await chromeNavigationFailure(page);
    if (message) throw new Error(message);
}

async function detectState(page: Page): Promise<LoginState> {
    const url = page.url();
    if (/^chrome-error:\/\//i.test(url) || /^about:blank$/i.test(url)) return 'unknown';
    try {
        // 未登录 lightweight shell 也有 Ask anything composer，不能仅凭输入框判定已登录
        const guestShell = !!(await first(page, LOGIN_SELECTORS) || await first(page, SIGNUP_SELECTORS));
        if (/chatgpt\.com\/(?:\?|$)|chatgpt\.com\/(?:c|g|share)\//i.test(url) && !/auth|login|signup|verify/i.test(url)
            && !guestShell && !await first(page, SIGNUP_EMAIL_SELECTORS)) {
            if (await first(page, AUTHENTICATED_SELECTORS)) return 'authenticated';
        }
        if (/\/mfa-challenge(?:[/?#]|$)/i.test(url) || await first(page, MFA_CHALLENGE_SELECTORS)) return 'mfa-challenge';
        if (await first(page, ["//input[@type='password' and not(@disabled)]"])) return 'password';
        if (await first(page, SIGNUP_EMAIL_SELECTORS)) return 'email';
        return 'unknown';
    } catch (error) {
        if (Utility.isStaleExecutionContextError(error))
            return 'unknown';
        throw error;
    }
}

async function waitForState(page: Page, expected: LoginState[], timeoutMs = 60_000): Promise<LoginState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await assertNoChromeNavigationFailure(page);
        const state = await detectState(page);
        if (expected.includes(state)) return state;
        await solveCloudflareIfPresent(page, 1);
    }
    await assertNoChromeNavigationFailure(page);
    return detectState(page);
}

/** 点击首页 Log in 并等待邮箱框 */
async function openLogin(page: Page): Promise<void> {
    if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;

    const deadline = Date.now() + 60_000;
    let lastError = '';
    while (Date.now() < deadline) {
        await assertNoChromeNavigationFailure(page);
        if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;
        await solveCloudflareIfPresent(page, 1);

        const button = await first(page, LOGIN_SELECTORS);
        if (!button) {
            lastError = '未找到 Log in 按钮';
            await Utility.waitForSeconds(0.5);
            continue;
        }

        try {
            // 必须点入口按钮以初始化 bottom-sheet；仅 dialog.showModal() 会开 DOM 但不渲染
            await button.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
            const box = await button.boundingBox();
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            else await button.evaluate(el => (el as HTMLElement).click());
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            await Utility.waitForSeconds(0.5);
            continue;
        }

        const opened = await Utility.waitForFunction(
            async () => {
                await solveCloudflareIfPresent(page, 1);
                return first(page, SIGNUP_EMAIL_SELECTORS);
            },
            { pollInterval: 400, timeout: 8_000 }
        ).catch(() => null);
        if (opened) return;
        lastError = '已点击 Log in，但邮箱输入框未出现';
    }

    // 弹层路径失败时走经典登录页
    await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60_000, retries: 2 });
    await solveCloudflareIfPresent(page);
    const emailOnAuth = await Utility.waitForFunction(
        () => first(page, SIGNUP_EMAIL_SELECTORS),
        { pollInterval: 400, timeout: 20_000 }
    ).catch(() => null);
    if (emailOnAuth) return;

    await assertNoChromeNavigationFailure(page);
    throw new Error(`打开 ChatGPT 登录入口超时（${lastError || '未知'}），URL：${page.url().replace(/[?#].*$/, '')}`);
}

async function submitMfa(page: Page, otpSecret: string): Promise<void> {
    const codeInput = await Utility.waitForFunction(
        () => first(page, MFA_CODE_SELECTORS),
        { timeout: 30_000 }
    );
    const code = authenticator.generate(otpSecret);
    await codeInput.click({ clickCount: 3 }).catch(() => undefined);
    await codeInput.type(code);
    const verifyButton = await first(page, MFA_VERIFY_SELECTORS);
    if (verifyButton) {
        await verifyButton.click();
        return;
    }
    await clickContinue(page);
}

async function extractAccessToken(page: Page): Promise<string> {
    return Utility.waitForFunction(async () => {
        try {
            const data = await page.evaluate(async () => {
                const response = await fetch('/api/auth/session', { credentials: 'include' });
                if (!response.ok) throw new Error(`session HTTP ${response.status}`);
                return await response.json() as Record<string, unknown>;
            });
            const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
            return accessToken || null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/session HTTP/i.test(message)) return null;
            throw new Error(`提取 accessToken 失败：${message}`);
        }
    }, { pollInterval: 500, timeout: 30_000 }).catch(() => {
        throw new Error('已登录但未能提取 accessToken');
    });
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
        const account = parseLoginAccount(process.env.CHATGPT_LOGIN ?? '');
        sensitiveValues.add(account.email);
        sensitiveValues.add(account.password);
        sensitiveValues.add(account.otpSecret);
        await validateCapSolver();

        const enable711Proxy = is711ProxyEnabled();
        const proxy = enable711Proxy ? buildJapanStickyProxy() : null;
        if (proxy) {
            sensitiveValues.add(proxy.password);
            sensitiveValues.add(process.env.PROXY_USERNAME ?? '');
        } else {
            logger.info('711Proxy 已关闭（ENABLE_711_PROXY），浏览器直连');
        }

        let page!: Page;
        for (let attempt = 1; attempt <= MAX_OPEN_CHATGPT_ATTEMPTS; attempt++) {
            if (proxy) {
                await preflightProxy(proxy);
                logger.info('711Proxy 预检通过：%s region=%s session=%s', proxy.server, proxy.region, proxy.session);
            }
            chrome = await puppeteer.launch({
                headless: os.platform() === 'linux',
                defaultViewport: { width: 1920, height: 1080 },
                protocolTimeout: MAX_TIMEOUT, slowMo: 20,
                handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
                args: [
                    ...(proxy ? [`--proxy-pac-url=${buildProxyPacUrl(proxy)}`] : []),
                    '--lang=en-US', '--window-size=1920,1080', '--disable-blink-features=AutomationControlled',
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas', '--no-zygote', '--disable-gpu'
                ]
            });
            logger.info(chrome.process()?.spawnfile, await chrome.version());
            page = await chrome.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            if (proxy) await page.authenticate({ username: proxy.username, password: proxy.password });
            networkCapture = installNetworkCapture(page, redactText);
            await installTurnstileHook(page);
            await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000, retries: 2 });
            const navError = await chromeNavigationFailure(page)
                ?? (!/chatgpt\.com/i.test(page.url())
                    ? `打开 ChatGPT 失败，当前 URL：${page.url().replace(/[?#].*$/, '') || 'about:blank'}`
                    : null);
            if (!navError) break;
            logger.warn('打开 ChatGPT 失败（%s/%s）：%s', attempt, MAX_OPEN_CHATGPT_ATTEMPTS, navError);
            networkCapture?.flush();
            networkCapture = undefined;
            await chrome.close().catch(() => undefined);
            chrome = undefined;
            if (attempt >= MAX_OPEN_CHATGPT_ATTEMPTS) throw new Error(navError);
            if (proxy) rotateStickySession(proxy);
        }

        await evidence(page, 'chatgpt-opened');
        await solveCloudflareIfPresent(page);
        await openLogin(page);
        await evidence(page, 'login-opened');
        await waitForEmailFormReady(page);
        await fillEmailInput(page, account.email);
        await evidence(page, 'email-entered');
        await clickContinue(page);
        await solveCloudflareIfPresent(page);

        let state = await waitForState(page, ['password', 'mfa-challenge', 'authenticated'], 45_000);
        // SSR 未水合时 Continue 只会刷新 ?email=；水合后或 login_with 再试一次
        if (state === 'email' || state === 'unknown') {
            logger.warn('邮箱 Continue 后仍为 %s，准备重试提交', state);
            if (!await navigateLoginWithFallback(page, account.email)) {
                await waitForEmailFormReady(page);
                await fillEmailInput(page, account.email);
                await clickContinue(page);
            }
            await solveCloudflareIfPresent(page);
            state = await waitForState(page, ['password', 'mfa-challenge', 'authenticated'], 60_000);
        }
        await evidence(page, `after-email-${state}`);

        if (state === 'password') {
            await page.type("//input[@type='password' and not(@disabled)]", account.password);
            await evidence(page, 'password-entered');
            await clickContinue(page);
            await solveCloudflareIfPresent(page);
            state = await waitForState(page, ['mfa-challenge', 'authenticated']);
            await evidence(page, `after-password-${state}`);
        }

        if (state === 'mfa-challenge') {
            await submitMfa(page, account.otpSecret);
            await evidence(page, 'mfa-submitted');
            await solveCloudflareIfPresent(page);
            state = await waitForState(page, ['authenticated'], 90_000);
            await evidence(page, `after-mfa-${state}`);
        }

        if (state !== 'authenticated') {
            await assertNoChromeNavigationFailure(page);
            throw new Error(`登录未进入已登录状态，当前状态：${state}，URL：${page.url().replace(/[?#].*$/, '')}`);
        }

        await evidence(page, 'authenticated');
        const accessToken = await extractAccessToken(page);
        // GitHub 会把日志里与 Secret 重合的子串打成 ***；Base64 后再打印可避开掩码。
        const accessTokenB64 = Buffer.from(accessToken, 'utf8').toString('base64');
        fs.writeFileSync('access-token.txt', accessToken, 'utf8');
        fs.writeFileSync('access-token.b64.txt', accessTokenB64, 'utf8');
        console.log('ACCESS_TOKEN_B64_BEGIN');
        console.log(accessTokenB64);
        console.log('ACCESS_TOKEN_B64_END');
        if (process.env.GITHUB_STEP_SUMMARY)
            fs.appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                `accessToken (Base64，本地解码：\`base64 -d\`)\n\n\`\`\`\n${accessTokenB64}\n\`\`\`\n`
            );

        const holdMinutes = resolveHoldMinutes();
        const holdUntil = Date.now() + holdMinutes * 60 * 1000;
        // 先回传 token，再进入保持等待
        await notifyWebAccountSuccess(account.email, accessToken, holdUntil);
        logger.info('已打印 access token（Base64）');
        await waitHoldMinutes(holdMinutes, holdUntil);
    } catch (error) {
        await fail(error);
    } finally {
        networkCapture?.flush();
        if (!exiting) await chrome?.close().catch(() => undefined);
    }
})();
