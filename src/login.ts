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

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const EVIDENCE_TIMEOUT_MS = 15_000;
const MAX_OPEN_CHATGPT_ATTEMPTS = 3;
const POST_LOGIN_WAIT_MS = 10 * 60 * 1000;
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
        const elements = await page.mainFrame().$$(selector) as ElementHandle<Element>[];
        for (const element of elements) {
            if (await element.isVisible().catch(() => false))
                return element;
        }
    }
    return null;
}

async function clickContinue(page: Page): Promise<void> {
    const button = await first(page, CONTINUE_SELECTORS);
    if (!button) throw new Error('找不到可用的非 OAuth Continue/提交按钮');
    const beforeUrl = page.url();
    try {
        const box = await button.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        else await button.evaluate(el => (el as HTMLElement).click());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (page.url() !== beforeUrl && /same JavaScript world|Execution context was destroyed|Target closed|detached/i.test(message))
            return;
        throw error;
    }
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
        const message = error instanceof Error ? error.message : String(error);
        if (/same JavaScript world|Execution context was destroyed|Target closed|detached/i.test(message))
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

    const openAuthDialog = async (): Promise<boolean> => {
        // lightweight shell：直接 showModal，避免 command=show-modal 连点变成开/关切换
        const opened = await page.evaluate(() => {
            const dialog = document.getElementById('mobile-auth-dialog') as HTMLDialogElement | null;
            if (!dialog) return false;
            if (!dialog.open) {
                if (typeof dialog.showModal === 'function') dialog.showModal();
                else dialog.setAttribute('open', '');
            }
            return dialog.open || dialog.hasAttribute('open');
        }).catch(() => false);
        if (opened && await first(page, SIGNUP_EMAIL_SELECTORS)) return true;

        const button = await first(page, LOGIN_SELECTORS);
        if (!button) return false;
        await button.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
        // 只点一次：show-modal 二次点击会关闭弹层
        const box = await button.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        else await button.evaluate(el => (el as HTMLElement).click());
        return true;
    };

    const deadline = Date.now() + 60_000;
    let lastError = '';
    while (Date.now() < deadline) {
        await assertNoChromeNavigationFailure(page);
        if (await first(page, SIGNUP_EMAIL_SELECTORS)) return;
        await solveCloudflareIfPresent(page, 1);

        try {
            if (!await openAuthDialog()) {
                lastError = '未找到 Log in 按钮或登录弹层';
                await Utility.waitForSeconds(0.5);
                continue;
            }
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
        lastError = '已尝试打开登录弹层，但邮箱输入框未出现';
    }

    // 弹层路径失败时走经典登录页，避免卡在游客 shell
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
        const emailInput = await first(page, SIGNUP_EMAIL_SELECTORS);
        if (!emailInput) throw new Error('登录邮箱输入框不可见');
        await emailInput.click({ clickCount: 3 }).catch(() => undefined);
        await emailInput.type(account.email);
        await evidence(page, 'email-entered');
        await clickContinue(page);
        await solveCloudflareIfPresent(page);

        let state = await waitForState(page, ['password', 'mfa-challenge', 'authenticated']);
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
        // 故意不掩码：本任务需要在 Actions 日志中可见 access token
        console.log('ACCESS_TOKEN_BEGIN');
        console.log(accessToken);
        console.log('ACCESS_TOKEN_END');
        if (process.env.GITHUB_STEP_SUMMARY)
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `accessToken\n\n\`\`\`\n${accessToken}\n\`\`\`\n`);
        logger.info('已打印 access token，开始等待 10 分钟后退出');

        const waitUntil = Date.now() + POST_LOGIN_WAIT_MS;
        while (Date.now() < waitUntil) {
            const remainSec = Math.ceil((waitUntil - Date.now()) / 1000);
            logger.info('登录保持中，剩余约 %s 秒', remainSec);
            await Utility.waitForSeconds(Math.min(60, remainSec));
        }
        logger.info('等待结束，准备退出');
    } catch (error) {
        await fail(error);
    } finally {
        networkCapture?.flush();
        if (!exiting) await chrome?.close().catch(() => undefined);
    }
})();
