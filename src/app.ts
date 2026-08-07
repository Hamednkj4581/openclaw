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
import { buildJapanStickyProxy, buildProxyPacUrl, is711ProxyEnabled, preflightProxy, rotateStickySession } from './proxy.js';
import { AUTHENTICATED_SELECTORS, CONTINUE_SELECTORS, LOGIN_SELECTORS, MFA_CHALLENGE_SELECTORS, MFA_CODE_SELECTORS, MFA_ENABLED_SELECTORS, MFA_VERIFY_SELECTORS, SIGNUP_EMAIL_SELECTORS, SIGNUP_SELECTORS } from './selectors.js';
import { cookieFileNameForEmail, writeCookieEditorJson } from './cookieExport.js';

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const EVIDENCE_TIMEOUT_MS = 15_000;
const VERIFICATION_EMAIL_TIMEOUT_MS = 30_000;
/** 浏览器打开 chatgpt.com 仍隧道失败时，换 sticky session 重开的次数 */
const MAX_OPEN_CHATGPT_ATTEMPTS = 3;
/** 打开注册入口失败时，关闭 page 再开首页的最大重试次数（不含首次） */
const MAX_SIGNUP_PAGE_RETRIES = 3;
type RegistrationState = 'email' | 'password' | 'email-verification' | 'code' | 'profile' | 'authenticated' | 'mfa-challenge' | 'unknown';
const sensitiveValues = new Set<string>();

function generatePassword(): string {
    return `Gpt!${randomBytes(15).toString('base64url')}9a`;
}

function redactHtml(html: string): string {
    let redacted = html
        .replace(/(<input\b[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
        .replace(/(<input\b[^>]*\b(?:type=["']password["']|name=["'](?:code|otp|token|password)["'])[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
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
        // 同一选择器可能命中隐藏副本（如侧栏悬停卡片），只返回可见元素
        const elements = await page.mainFrame().$$(selector) as ElementHandle<Element>[];
        for (const element of elements) {
            if (await element.isVisible().catch(() => false))
                return element;
        }
    }
    return null;
}

/** 等待邮箱表单完成 React 水合，避免 Continue 变成原生 GET 刷新 */
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
        throw new Error('注册邮箱表单未完成 React 水合，继续提交只会触发原生刷新');
    });
}

/** 写入受控邮箱输入：键盘输入 + 原生 value setter，确保 React state 同步 */
async function fillEmailInput(page: Page, email: string): Promise<void> {
    const emailInput = await first(page, SIGNUP_EMAIL_SELECTORS);
    if (!emailInput) throw new Error('注册邮箱输入框不可见');
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
        // 坐标点击，避免导航销毁上下文时 ElementHandle.click 触发 world 错乱
        const box = await button.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        else await button.evaluate(el => (el as HTMLElement).click());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const navigatedAway = page.url() !== beforeUrl;
        if (navigatedAway && /same JavaScript world|Execution context was destroyed|Target closed|detached/i.test(message))
            return;
        throw error;
    }
}

/** bottom-sheet 邮箱表单提交失败时，按表单字段拼 GET 跳转（login_with / signup） */
async function navigateEmailFormFallback(page: Page, email: string): Promise<boolean> {
    const target = await page.evaluate((emailValue) => {
        const form = document.querySelector('form[data-auth-provider="email"]') as HTMLFormElement | null;
        if (!form?.action || !/(login_with|signup)/i.test(form.action)) return '';
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
    logger.info('邮箱 Continue 未前进，改走邮箱表单跳转兜底');
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000, retries: 2 });
    return true;
}

/** 点击首页 Sign up 并等待邮箱框；失败由外层重开 page，不再走 Auth URL 兜底。 */
async function openSignup(page: Page): Promise<void> {
    if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;

    const deadline = Date.now() + 60_000;
    let lastError = '';
    while (Date.now() < deadline) {
        // 代理隧道失败时页面停在 chrome-error，继续找 Sign up 只会空转至超时
        await assertNoChromeNavigationFailure(page);
        if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;
        await solveCloudflareIfPresent(page, 1);

        const button = await first(page, SIGNUP_SELECTORS);
        if (!button) {
            lastError = '未找到 Sign up 按钮';
            await Utility.waitForSeconds(0.5);
            continue;
        }

        try {
            // 必须点入口按钮以初始化 bottom-sheet；只点一次避免 show-modal 开/关切换
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
        lastError = '已点击 Sign up，但邮箱输入框未出现';
    }

    await assertNoChromeNavigationFailure(page);
    const title = await page.title().catch(() => '');
    throw new Error(`打开 ChatGPT 注册入口超时（${lastError || '未知'}），URL：${page.url().replace(/[?#].*$/, '')}，标题：${title}`);
}

/** 在已有浏览器中新建 page 并打开 chatgpt 首页（供注册入口失败后重试）。 */
async function reopenChatGptPage(
    browser: Browser,
    oldPage: Page,
    proxy: { username: string; password: string } | null,
    redactText: (text: string) => string,
): Promise<{ page: Page; networkCapture: ReturnType<typeof installNetworkCapture> }> {
    await oldPage.close().catch(() => undefined);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    if (proxy) await page.authenticate({ username: proxy.username, password: proxy.password });
    const networkCapture = installNetworkCapture(page, redactText);
    await installTurnstileHook(page);
    await page.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
        retries: 2,
    });
    const navError = await chromeNavigationFailure(page)
        ?? (!/chatgpt\.com/i.test(page.url())
            ? `打开 ChatGPT 失败，当前 URL：${page.url().replace(/[?#].*$/, '') || 'about:blank'}`
            : null);
    if (navError) throw new Error(navError);
    return { page, networkCapture };
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
    // chrome-error / 导航中的 about:blank 上继续查选择器会触发 Puppeteer world 错乱，先短路。
    if (/^chrome-error:\/\//i.test(url) || /^about:blank$/i.test(url)) return 'unknown';
    try {
        // 未登录 lightweight shell 也有 Ask anything composer；有 Log in/Sign up 或邮箱框时不算已登录。
        const guestShell = !!(await first(page, LOGIN_SELECTORS) || await first(page, SIGNUP_SELECTORS));
        if (/chatgpt\.com\/(?:\?|$)|chatgpt\.com\/(?:c|g|share)\//i.test(url) && !/auth|login|signup|verify/i.test(url)
            && !guestShell && !await first(page, SIGNUP_EMAIL_SELECTORS)) {
            // 注册完成后的 You're all set 会挡住主界面；出现即表示已登录成功
            if (await youreAllSetOpen(page)) return 'authenticated';
            if (await first(page, AUTHENTICATED_SELECTORS)) return 'authenticated';
        }
        if (await first(page, ["//input[@type='password' and not(@disabled)]"])) return 'password';
        if (/\/about-you(?:[/?#]|$)/i.test(url) || await first(page, ["//input[@placeholder='Full name' or @name='name']", "//input[@name='age' or @name='birthday']", "//*[@data-type='month']"])) return 'profile';
        if (/\/mfa-challenge(?:[/?#]|$)/i.test(url) || await first(page, MFA_CHALLENGE_SELECTORS)) return 'mfa-challenge';
        if (await first(page, ["//input[@name='code' or @autocomplete='one-time-code' or @inputmode='numeric']"])) return 'code';
        if (/email-verification/i.test(url) || await first(page, ["//*[contains(translate(normalize-space(.), 'VERIFY YOUR EMAILCHECK YOUR EMAIL', 'verify your emailcheck your email'), 'verify your email') or contains(translate(normalize-space(.), 'VERIFY YOUR EMAILCHECK YOUR EMAIL', 'verify your emailcheck your email'), 'check your email')]"])) return 'email-verification';
        if (await first(page, SIGNUP_EMAIL_SELECTORS)) return 'email';
        return 'unknown';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/same JavaScript world|Execution context was destroyed|Target closed|detached/i.test(message))
            return 'unknown';
        throw error;
    }
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

/** 导出格式与截图一致：session 接口字段 + Cookie 中的 sessionToken */
type SessionExport = {
    user: { id: string; email: string };
    expires: string;
    account: { id: string; planType: string };
    accessToken: string;
    sessionToken: string;
    authProvider: string;
};

/** 读取 next-auth session cookie；过长时会被拆成 .0/.1/... 分片，需按序号拼接 */
function readSessionTokenFromCookies(cookies: Array<{ name: string; value: string }>): string | null {
    const exact = cookies.find(c => c.name === '__Secure-next-auth.session-token' || c.name === 'next-auth.session-token');
    if (exact?.value) return exact.value;

    const chunkRe = /^(?:__Secure-)?next-auth\.session-token\.(\d+)$/;
    const chunks = cookies
        .flatMap(c => {
            const match = c.name.match(chunkRe);
            return match ? [{ index: Number(match[1]), value: c.value }] : [];
        })
        .sort((a, b) => a.index - b.index);
    if (!chunks.length) return null;
    const token = chunks.map(c => c.value).join('');
    return token || null;
}

function writeSessionJson(session: SessionExport): void {
    const filePath = process.env.ACCOUNT_SESSION_JSON_PATH || 'session.json';
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n');
    logger.info('已导出 session JSON：%s', filePath);
}

/** 按邮箱写出 Cookie-Editor JSON，供后续导入浏览器 */
function writeAccountCookies(email: string, cookies: Array<{
    name: string; value: string; domain: string; path?: string;
    expires?: number; httpOnly?: boolean; secure?: boolean; session?: boolean; sameSite?: string;
}>): string {
    const dir = process.env.ACCOUNT_COOKIE_DIR || '.';
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, cookieFileNameForEmail(email));
    const count = writeCookieEditorJson(filePath, cookies);
    logger.info('已导出 Cookie-Editor JSON：%s（%s 条）', filePath, count);
    return filePath;
}

async function extractSessionExport(page: Page): Promise<SessionExport> {
    return Utility.waitForFunction(async () => {
        try {
            const data = await page.evaluate(async () => {
                const response = await fetch('/api/auth/session', { credentials: 'include' });
                if (!response.ok)
                    throw new Error(`session HTTP ${response.status}`);
                return await response.json() as Record<string, unknown>;
            });
            const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
            if (!accessToken) return null;

            const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : undefined;
            const account = data.account && typeof data.account === 'object' ? data.account as Record<string, unknown> : undefined;
            const userId = typeof user?.id === 'string' ? user.id : '';
            const userEmail = typeof user?.email === 'string' ? user.email : '';
            const expires = typeof data.expires === 'string' ? data.expires : '';
            const accountId = typeof account?.id === 'string' ? account.id : '';
            const planType = typeof account?.planType === 'string' ? account.planType : '';
            const authProvider = typeof data.authProvider === 'string' && data.authProvider ? data.authProvider : 'openai';
            if (!userId || !userEmail || !expires || !accountId || !planType) return null;

            const sessionToken = readSessionTokenFromCookies(await page.cookies());
            if (!sessionToken) return null;

            return {
                user: { id: userId, email: userEmail },
                expires,
                account: { id: accountId, planType },
                accessToken,
                sessionToken,
                authProvider,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/session HTTP/i.test(message)) return null;
            throw new Error(`提取 ChatGPT session 失败：${message}`);
        }
    }, { pollInterval: 500, timeout: 30_000 }).catch(() => {
        throw new Error('已登录但未能导出完整 session JSON（accessToken/sessionToken）');
    });
}

/** 不要求可见：You're all set 弹层常带 aria-hidden，isVisible 会误判为不存在。 */
async function firstPresent(page: Page, selectors: string[]): Promise<ElementHandle<Element> | null> {
    for (const selector of selectors) {
        const element = await page.$x(selector, { timeout: 0, visible: false });
        if (element) return element as ElementHandle<Element>;
    }
    return null;
}

function youreAllSetOpen(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="You\'re all set"][open]');
        if (dialog) return true;
        return Array.from(document.querySelectorAll('[aria-modal="true"]'))
            .some(el => (el.textContent ?? '').includes("You're all set"));
    });
}

/** 注册后可能弹出 You're all set 引导层，挡住设置面板交互。 */
async function dismissYoureAllSetIfPresent(page: Page): Promise<void> {
    if (!await youreAllSetOpen(page)) return;
    // Continue 常短暂 disabled + spinner；点禁用按钮无效，先等到可点
    const ready = await Utility.waitForFunction(async () => {
        if (!await youreAllSetOpen(page)) return 'gone' as const;
        return page.evaluate(() => {
            const dialog = document.querySelector('dialog[aria-label="You\'re all set"][open]')
                ?? Array.from(document.querySelectorAll('[aria-modal="true"]'))
                    .find(el => (el.textContent ?? '').includes("You're all set"));
            if (!dialog) return 'gone';
            const button = Array.from(dialog.querySelectorAll('button'))
                .find(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith('Continue')) as HTMLButtonElement | undefined;
            if (!button) return null;
            if (button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
            return 'ready';
        });
    }, { timeout: 60_000 });
    if (ready === 'gone') return;
    const clicked = await page.evaluate(() => {
        const dialog = document.querySelector('dialog[aria-label="You\'re all set"][open]')
            ?? Array.from(document.querySelectorAll('[aria-modal="true"]'))
                .find(el => (el.textContent ?? '').includes("You're all set"));
        if (!dialog) return false;
        const button = Array.from(dialog.querySelectorAll('button'))
            .find(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith('Continue')) as HTMLButtonElement | undefined;
        if (!button) return false;
        button.click();
        return true;
    });
    if (!clicked) {
        // 回退到句柄点击（含 spinner 的 Continue 文案可能带额外 SVG）
        const continueButton = await firstPresent(page, [
            "//dialog[@aria-label=\"You're all set\"]//button[contains(normalize-space(.), 'Continue')]",
            "//*[@aria-modal='true'][.//*[normalize-space(.)=\"You're all set\"]]//button[contains(normalize-space(.), 'Continue')]"
        ]);
        if (!continueButton) throw new Error('检测到 You\'re all set 引导层，但找不到 Continue');
        await continueButton.evaluate(el => (el as HTMLElement).click());
    }
    await Utility.waitForFunction(async () => (await youreAllSetOpen(page)) ? null : true, { timeout: 30_000 });
}

async function enableMfa(page: Page, evidence: (page: Page, stage: string) => Promise<void>): Promise<string> {
    // 先关掉引导层再进设置；hash 跳转后弹层可能再次出现
    await dismissYoureAllSetIfPresent(page);
    await page.goto('https://chatgpt.com/#settings/Security');
    const authenticatorToggle = await Utility.waitForFunction(async () => {
        await dismissYoureAllSetIfPresent(page);
        if (await youreAllSetOpen(page)) return null;
        return first(page, [
            "//button[@data-testid='mfa-authenticator-toggle' and @role='switch']",
            "//button[@aria-label='Multi-factor authentication']",
            "//button[@role='switch' and contains(translate(@aria-label, 'AUTHENTICATOR', 'authenticator'), 'authenticator')]",
            "//*[normalize-space(.)='Authenticator app']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']"
        ]);
    }, { timeout: 60_000 });
    await evidence(page, 'mfa-security-settings');
    if (await first(page, MFA_ENABLED_SELECTORS))
        throw new Error('ChatGPT 验证器 MFA 已启用，无法重新读取现有 OTP 密钥；已保留当前 MFA 设置');
    await authenticatorToggle.evaluate(el => (el as HTMLElement).click());
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
        const enable711Proxy = is711ProxyEnabled();
        const proxy = enable711Proxy ? buildJapanStickyProxy() : null;
        if (proxy) {
            sensitiveValues.add(proxy.password);
            sensitiveValues.add(process.env.PROXY_USERNAME ?? '');
        } else {
            logger.info('711Proxy 已关闭（ENABLE_711_PROXY），浏览器直连');
        }
        const registrationStartedAt = new Date(Date.now() - 30_000);
        const enableChatGptMfa = ['1', 'true'].includes((process.env.ENABLE_CHATGPT_MFA ?? 'true').toLowerCase());
        const chatGptPassword = generatePassword();
        let page!: Page;
        for (let attempt = 1; attempt <= MAX_OPEN_CHATGPT_ATTEMPTS; attempt++) {
            if (proxy) {
                await preflightProxy(proxy);
                logger.info('711Proxy 预检通过：%s region=%s session=%s sessTime=%smin（仅测 api.chatgpt.com/v1；PAC：静态资源直连，其余走代理）',
                    proxy.server, proxy.region, proxy.session, proxy.sessTime);
            }
            chrome = await puppeteer.launch({
                headless: os.platform() === 'linux',
                // 固定视口：defaultViewport:null 在 headless Linux 上偶发 0x0，导致点击 Sign up 无 auth 请求、截图报 0 width
                defaultViewport: { width: 1920, height: 1080 },
                protocolTimeout: MAX_TIMEOUT, slowMo: 20,
                handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
                args: [
                    // 启用代理时：PAC 静态资源直连，HTML/接口走日本代理（page.authenticate 仍作用于代理请求）
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
            // 抓取全程 URL 写入 evidence，供分析哪些主机/资源不必走住宅代理
            networkCapture = installNetworkCapture(page, redactText);
            await installTurnstileHook(page);
            await page.goto('https://chatgpt.com/', {
                // 首页资源多，load 易触达 30s；domcontentloaded 即可继续点 Sign up
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
                // 默认 5 次重试会空耗约 150s，挤掉后续导出 session 的时间
                retries: 2,
            });
            // patches 的 goto 耗尽重试后可能静默停在 chrome-error / about:blank，需主动识别并换出口
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
        await evidence(page, 'initial-turnstile-checked');
        for (let retry = 0; ; retry++) {
            try {
                await openSignup(page);
                break;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (retry >= MAX_SIGNUP_PAGE_RETRIES) throw error;
                logger.warn('打开注册入口失败（重试 %s/%s），关闭 page 并重新打开首页：%s',
                    retry + 1, MAX_SIGNUP_PAGE_RETRIES, message);
                networkCapture?.flush();
                networkCapture = undefined;
                const reopened = await reopenChatGptPage(chrome!, page, proxy, redactText);
                page = reopened.page;
                networkCapture = reopened.networkCapture;
                await evidence(page, `chatgpt-reopened-${retry + 1}`);
                await solveCloudflareIfPresent(page);
                await evidence(page, `reopen-turnstile-checked-${retry + 1}`);
            }
        }
        await evidence(page, 'signup-opened');
        await solveCloudflareIfPresent(page);
        await waitForEmailFormReady(page);
        await fillEmailInput(page, email);
        await evidence(page, 'email-entered');
        await clickContinue(page);
        await solveCloudflareIfPresent(page);

        let state = await waitForState(page, ['password', 'email-verification', 'code', 'profile', 'authenticated'], 45_000);
        // SSR 未水合时 Continue 只会刷新邮箱页；水合后或表单跳转再试一次
        if (state === 'email' || state === 'unknown') {
            logger.warn('邮箱 Continue 后仍为 %s，准备重试提交', state);
            if (!await navigateEmailFormFallback(page, email)) {
                await waitForEmailFormReady(page);
                await fillEmailInput(page, email);
                await clickContinue(page);
            }
            await solveCloudflareIfPresent(page);
            state = await waitForState(page, ['password', 'email-verification', 'code', 'profile', 'authenticated'], 60_000);
        }
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
        // 先导出 session/cookie：2FA 开启失败不得影响注册成功后的产物
        const session = await extractSessionExport(page);
        sensitiveValues.add(session.accessToken);
        sensitiveValues.add(session.sessionToken);
        writeSessionJson(session);
        writeAccountCookies(email, await page.cookies());
        await evidence(page, 'access-token-ready');

        let otpSecret: string | undefined;
        if (enableChatGptMfa) {
            try {
                otpSecret = await enableMfa(page, evidence);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn('开启 ChatGPT 2FA 失败，不影响后续流程：%s', message);
                githubAnnotation('warning', `开启 ChatGPT 2FA 失败，已跳过：${message}`);
                await evidence(page, 'mfa-enable-failed').catch(() => undefined);
            }
        }

        Utility.appendStepSummary(
            [email, chatGptPassword, ...(otpSecret ? [otpSecret] : []), session.accessToken, new Date().toString()].join('----')
        );
        logger.info('ChatGPT 注册完成%s，已提取 accessToken 并导出 session/cookie', otpSecret ? '，已开启 2FA' : '');
    } catch (error) {
        await fail(error);
    } finally {
        networkCapture?.flush();
        if (!exiting) await chrome?.close().catch(() => undefined);
    }
})();