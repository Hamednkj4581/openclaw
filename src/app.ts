import './loadEnv.js';
import './patches.js';
import os from 'os';
import { randomBytes } from 'crypto';
import puppeteer, { Browser, Page } from 'puppeteer';
import { authenticator } from 'otplib';
import Utility from './Utility.js';
import logger from './logger.js';
import githubAnnotation from './annotations.js';
import { waitForChatGptCode } from './outlookMail.js';
import { installTurnstileHook, solveCloudflareIfPresent, validateCapSolver } from './capsolver.js';

const MAX_TIMEOUT = Math.pow(2, 31) - 1;
const REQUIRED_ENV = ['EMAIL', 'EMAIL_PASSWORD', 'CLIENT_ID', 'REFRESH_TOKEN'] as const;

function requiredEnv(name: typeof REQUIRED_ENV[number]): string {
    const value = process.env[name]?.trim();
    if (!value)
        throw new Error(`缺少环境变量 ${name}`);
    return value;
}

function generatePassword(): string {
    return `Gpt!${randomBytes(15).toString('base64url')}9a`;
}

async function screenshotAllPages(browser: Browser) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pages = await browser.pages();
    for (let i = 0; i < pages.length; i++)
        await pages[i].screenshot({ path: `./images/chrome-${timestamp}-${i + 1}.png` }).catch(logger.error);
}

async function enableMfa(page: Page): Promise<string> {
    await page.goto('https://chatgpt.com/#settings/Security');
    await page.click("//button[@aria-label='Multi-factor authentication']");
    await page.click("//span[contains(., 'Trouble scanning?')]");
    const otpSecret = await page.textContent("//button[text()='Copy code']/preceding-sibling::div");
    if (!otpSecret)
        throw new Error('无法读取 ChatGPT OTP 密钥');

    await page.type("//input[@name='code']", authenticator.generate(otpSecret));
    await page.click("//button[contains(., 'Continue')]");
    await page.click("//input[@id='safelyRecorded']");
    await page.click("//button[contains(., 'Continue') and not(@disabled)]");
    return otpSecret;
}

(async () => {
    let chrome: Browser | undefined;
    let exiting = false;

    const fail = async (error: unknown) => {
        if (exiting)
            return;
        exiting = true;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        githubAnnotation('error', message);
        if (chrome)
            await screenshotAllPages(chrome);
        await chrome?.close().catch(() => undefined);
        process.exitCode = 1;
    };

    process.once('SIGTERM', () => void fail(new Error('SIGTERM: 终止请求')));
    process.once('unhandledRejection', error => void fail(error));

    try {
        const email = requiredEnv('EMAIL');
        requiredEnv('EMAIL_PASSWORD');
        const clientId = requiredEnv('CLIENT_ID');
        const refreshToken = requiredEnv('REFRESH_TOKEN');
        await validateCapSolver();
        const enableChatGptMfa = process.env.ENABLE_CHATGPT_MFA === '1' || process.env.ENABLE_CHATGPT_MFA === 'true';
        const chatGptPassword = generatePassword();
        const headless = os.platform() === 'linux';

        chrome = await puppeteer.launch({
            headless,
            defaultViewport: null,
            protocolTimeout: MAX_TIMEOUT,
            slowMo: 20,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            args: [
                '--lang=en-US',
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        logger.info(chrome.process()?.spawnfile, await chrome.version());
        const page = await chrome.newPage();
        await installTurnstileHook(page);
        const registrationStartedAt = new Date(Date.now() - 30_000);

        await page.goto('https://chatgpt.com/');
        await page.click("//button[contains(., 'Sign up for free')]");
        await solveCloudflareIfPresent(page);
        await page.type("//input[@name='email']", email, { timeout: 60_000 });
        await page.click("//button[normalize-space(.)='Continue' and not(.//*[contains(normalize-space(.), 'Google')])]");
        await solveCloudflareIfPresent(page);
        await page.type("//input[@name='new-password']", chatGptPassword, { timeout: 60_000 });
        await page.click("//button[normalize-space(.)='Continue']");

        logger.info('等待 ChatGPT 验证邮件');
        const code = await waitForChatGptCode(
            { email, clientId, refreshToken },
            { receivedAfter: registrationStartedAt }
        );
        logger.info('收到 ChatGPT 验证邮件');

        await page.type("//input[@name='code']", code);
        await page.click("//button[contains(., 'Continue')]");
        const fullName = email.split('@')[0].replace(/[^a-zA-Z]/g, '') || 'ChatGPT User';
        await page.type("//input[@placeholder='Full name']", fullName);
        await page.type('//div[contains(@id,"-birthday")]//div[@contenteditable="true" and @data-type="month"]', String(Math.floor(Math.random() * 12) + 1));
        await page.type('//div[contains(@id,"-birthday")]//div[@contenteditable="true" and @data-type="day"]', String(Math.floor(Math.random() * 28) + 1));
        await page.type('//div[contains(@id,"-birthday")]//div[@contenteditable="true" and @data-type="year"]', String(1980 + Math.floor(Math.random() * 30)));
        await page.click("//button[contains(., 'Continue')]");
        await page.waitForNavigation({ timeout: 60_000 });

        const otpSecret = enableChatGptMfa ? await enableMfa(page) : undefined;
        const result = otpSecret
            ? [email, chatGptPassword, otpSecret, new Date().toString()]
            : [email, chatGptPassword, new Date().toString()];
        Utility.appendStepSummary(JSON.stringify(result));
        logger.info('ChatGPT 注册完成%s', otpSecret ? '，已开启 2FA' : '');
    }
    catch (error) {
        await fail(error);
    }
    finally {
        if (!exiting)
            await chrome?.close().catch(() => undefined);
    }
})();
