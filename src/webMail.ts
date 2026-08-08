import axios from 'axios';
import Utility from './Utility.js';
import logger from './logger.js';
import { ChatGptVerification, WaitForVerificationOptions } from './outlookMail.js';
import { resolveWebMailAdapter, type WebMailCredentials } from './webMailHosts.js';

export type { WebMailCredentials } from './webMailHosts.js';

const DEFAULT_VERIFICATION_TIMEOUT_MS = 90_000;
const baselineVerifications = new WeakMap<WebMailCredentials, string | undefined>();

function maskEmail(email: string): string {
    const [name, domain = ''] = email.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
}

function safeMessage(value: unknown, credentials: WebMailCredentials): string {
    return String(value ?? 'unknown')
        .replaceAll(credentials.mailboxUrl, '[REDACTED_MAILBOX_URL]')
        .replaceAll(credentials.email, maskEmail(credentials.email))
        .slice(0, 500);
}

function webMailError(credentials: WebMailCredentials, stage: string, category: string, error: any, retryable: boolean, action: string): Error {
    const details = {
        email: maskEmail(credentials.email),
        stage,
        category,
        status: error?.response?.status ?? error?.code ?? null,
        message: safeMessage(error?.message ?? error, credentials),
        retryable,
        action
    };
    return new Error(`WEB_MAIL ${JSON.stringify(details)}`);
}

/** 解码 Cloudflare Email Protection 的 data-cfemail */
function decodeCloudflareEmail(hex: string): string | undefined {
    try {
        const bytes = Buffer.from(hex, 'hex');
        if (bytes.length < 2) return undefined;
        const key = bytes[0]!;
        let out = '';
        for (let i = 1; i < bytes.length; i++) out += String.fromCharCode(bytes[i]! ^ key);
        return out;
    } catch {
        return undefined;
    }
}

/** 页面是否提及目标邮箱（明文、URL 编码，或 Cloudflare 混淆） */
export function pageMentionsEmail(html: string, email: string): boolean {
    const emailLower = email.toLowerCase();
    const lower = html.toLowerCase();
    if (lower.includes(emailLower) || lower.includes(encodeURIComponent(email).toLowerCase()))
        return true;
    for (const match of html.matchAll(/\bdata-cfemail=["']([0-9a-fA-F]+)["']/g)) {
        const decoded = decodeCloudflareEmail(match[1]!);
        if (decoded?.toLowerCase() === emailLower) return true;
    }
    return false;
}

function validateCredentials(credentials: WebMailCredentials): URL {
    if (!/^\S+@\S+\.\S+$/.test(credentials.email))
        throw webMailError(credentials, 'input_validation', 'invalid_email', new Error('邮箱格式无效'), false, '修正网页取件账号输入格式');

    let url: URL;
    try {
        url = new URL(credentials.mailboxUrl);
    }
    catch (error) {
        throw webMailError(credentials, 'input_validation', 'invalid_url', error, false, '第二字段必须是完整的 HTTP(S) 网页取件链接');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw webMailError(credentials, 'input_validation', 'invalid_url', new Error('仅支持不含用户名密码的 HTTP(S) URL'), false, '修正网页取件链接');

    const pathEmail = url.pathname.split('/').filter(Boolean).at(-1);
    let decodedPathEmail = '';
    try {
        decodedPathEmail = pathEmail ? decodeURIComponent(pathEmail) : '';
    }
    catch (error) {
        throw webMailError(credentials, 'input_validation', 'invalid_url_encoding', error, false, '修正网页取件链接中的邮箱编码');
    }
    if (decodedPathEmail.toLowerCase() !== credentials.email.toLowerCase())
        throw webMailError(credentials, 'input_validation', 'email_mismatch', new Error('链接中的邮箱与账号邮箱不一致'), false, '确认网页取件链接属于当前邮箱');
    return url;
}

async function fetchMailboxPage(credentials: WebMailCredentials): Promise<string> {
    validateCredentials(credentials);
    try {
        const { data } = await axios.get<string>(credentials.mailboxUrl, {
            headers: {
                accept: 'text/html,application/xhtml+xml',
                'cache-control': 'no-cache',
                pragma: 'no-cache'
            },
            params: { _: Date.now() },
            responseType: 'text',
            timeout: 15_000
        });
        if (typeof data !== 'string' || !/<(?:!doctype|html|body)\b/i.test(data))
            throw new Error('网页取件链接返回内容不是 HTML');
        if (!pageMentionsEmail(data, credentials.email))
            throw new Error('网页内容与当前邮箱不匹配');
        return data;
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('WEB_MAIL ')) throw error;
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const denied = status === 401 || status === 403 || status === 404;
            throw webMailError(
                credentials,
                'page_request',
                denied ? 'mailbox_link_rejected' : status ? 'page_error' : 'network_error',
                error,
                !denied && (!status || status >= 500),
                denied ? '确认网页取件链接有效且未过期' : '检查网页取件服务和网络后重试'
            );
        }
        throw webMailError(credentials, 'page_response', 'invalid_response', error, false, '检查网页取件链接及页面格式');
    }
}

/** 按取件链接域名选择适配器后提取验证信息 */
export function extractWebMailVerification(html: string, mailboxUrlOrHost?: string): ChatGptVerification | undefined {
    let hostname = '';
    if (mailboxUrlOrHost) {
        try {
            hostname = mailboxUrlOrHost.includes('://')
                ? new URL(mailboxUrlOrHost).hostname
                : mailboxUrlOrHost;
        } catch {
            hostname = mailboxUrlOrHost;
        }
    }
    const adapter = resolveWebMailAdapter(hostname);
    return adapter.extract(html, { email: '', mailboxUrl: mailboxUrlOrHost || '' });
}

function verificationKey(verification: ChatGptVerification | undefined): string | undefined {
    return verification ? `${verification.type}:${verification.value}` : undefined;
}

export async function preflightWebMail(credentials: WebMailCredentials): Promise<void> {
    const url = validateCredentials(credentials);
    const adapter = resolveWebMailAdapter(url.hostname);
    const html = await fetchMailboxPage(credentials);
    baselineVerifications.set(credentials, verificationKey(adapter.extract(html, credentials)));
    logger.info('网页邮箱预检成功：%s，服务：%s，适配器：%s', maskEmail(credentials.email), url.hostname, adapter.id);
}

export async function waitForWebMailVerification(
    credentials: WebMailCredentials,
    options: WaitForVerificationOptions
): Promise<ChatGptVerification> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const baseline = baselineVerifications.get(credentials);
    const adapter = resolveWebMailAdapter(new URL(credentials.mailboxUrl).hostname);

    while (Date.now() < deadline) {
        const verification = adapter.extract(await fetchMailboxPage(credentials), credentials);
        if (verification && verificationKey(verification) !== baseline) return verification;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        logger.info('网页邮箱尚未返回新的 ChatGPT 验证码，等待下一次轮询（剩余约 %d 秒）', Math.ceil(remainingMs / 1000));
        await Utility.waitForSeconds(Math.min(pollIntervalMs, remainingMs) / 1000);
    }

    throw new Error(`等待网页邮箱 ChatGPT 验证码超时（${Math.round(timeoutMs / 1000)} 秒）`);
}
