import axios from 'axios';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Utility from './Utility.js';
import logger from './logger.js';

export interface OutlookCredentials {
    /** ChatGPT 注册邮箱；未设置 mailboxEmail 时同时作为 IMAP 登录邮箱 */
    email: string;
    clientId: string;
    refreshToken: string;
    /** 转发收件箱：用其登录 IMAP，并按 email 过滤收件人 */
    mailboxEmail?: string;
}

export interface WaitForVerificationOptions {
    receivedAfter: Date;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

export type ChatGptVerification =
    | { type: 'code'; value: string }
    | { type: 'link'; value: string };

const DEFAULT_VERIFICATION_TIMEOUT_MS = 30_000;

function maskEmail(email: string): string {
    const [name, domain = ''] = email.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
}

function imapUser(credentials: OutlookCredentials): string {
    return credentials.mailboxEmail ?? credentials.email;
}

function safeMessage(value: unknown, credentials: OutlookCredentials): string {
    let message = String(value ?? 'unknown').replace(credentials.refreshToken, '[REDACTED]');
    message = message.replaceAll(credentials.email, maskEmail(credentials.email));
    if (credentials.mailboxEmail)
        message = message.replaceAll(credentials.mailboxEmail, maskEmail(credentials.mailboxEmail));
    return message.slice(0, 500);
}

function preflightError(
    credentials: OutlookCredentials,
    stage: string,
    category: string,
    error: any,
    retryable: boolean,
    action: string
): Error {
    const details = {
        email: maskEmail(credentials.email),
        mailboxEmail: credentials.mailboxEmail ? maskEmail(credentials.mailboxEmail) : undefined,
        stage,
        category,
        status: error?.response?.status ?? error?.responseStatus ?? error?.statusCode ?? error?.code ?? null,
        serverError: error?.response?.data?.error ?? error?.serverResponseCode ?? error?.code ?? null,
        message: safeMessage(error?.response?.data?.error_description ?? error?.message ?? error, credentials),
        retryable,
        action
    };
    return new Error(`OUTLOOK_PREFLIGHT ${JSON.stringify(details)}`);
}

function classifyNetworkError(error: any): { category: string; retryable: boolean; action: string } {
    const code = String(error?.code ?? '').toUpperCase();
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code))
        return { category: 'dns_error', retryable: true, action: '检查 DNS 和网络后重试' };
    if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code))
        return { category: 'network_timeout', retryable: true, action: '检查网络连通性后重试' };
    if (/TLS|CERT|SSL/.test(code))
        return { category: 'tls_error', retryable: false, action: '检查系统时间、证书和 TLS 代理配置' };
    return { category: 'network_error', retryable: true, action: '检查网络和 Outlook 服务状态后重试' };
}

async function getAccessToken(credentials: OutlookCredentials): Promise<string> {
    const body = new URLSearchParams({
        client_id: credentials.clientId,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken
    });

    try {
        const { data } = await axios.post(
            'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            body,
            { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
        );

        if (!data.access_token)
            throw new Error(`响应中没有 access_token: ${data.error ?? 'unknown_error'}`);
        return data.access_token;
    }
    catch (error) {
        if (axios.isAxiosError(error)) {
            const code = error.response?.data?.error ?? error.code ?? 'request_failed';
            const description = String(error.response?.data?.error_description ?? error.message);
            if (code === 'invalid_grant') {
                const expired = /expired|sign in again|重新登录/i.test(description);
                throw preflightError(credentials, 'oauth_token_exchange', 'invalid_grant', error, false,
                    expired ? 'refresh token 已失效，请重新登录 Outlook 并提供新 token' : '请重新授权 Outlook 并更新 refresh token');
            }
            if (code === 'invalid_client')
                throw preflightError(credentials, 'oauth_token_exchange', 'invalid_client', error, false, '确认 client_id 与 refresh token 来自同一应用');
            const network = classifyNetworkError(error);
            throw preflightError(credentials, 'oauth_token_exchange', error.response ? 'oauth_token_error' : network.category,
                error,
                error.response ? error.response.status >= 500 : network.retryable,
                error.response ? '检查 Microsoft OAuth 响应及应用授权配置' : network.action);
        }
        throw error;
    }
}

function createClient(credentials: OutlookCredentials, accessToken: string): ImapFlow {
    return new ImapFlow({
        host: 'outlook.live.com',
        port: 993,
        secure: true,
        auth: { user: imapUser(credentials), accessToken },
        logger: false
    });
}

/** 汇总 To/Cc/Delivered-To 等收件相关头，供转发场景按注册邮箱过滤 */
export function collectRecipientText(message: {
    envelope?: { to?: Array<{ address?: string | null }> | null; cc?: Array<{ address?: string | null }> | null } | null;
    to?: unknown;
    cc?: unknown;
    headers?: { get?(name: string): unknown };
}): string {
    const parts: string[] = [];
    const pushAddresses = (value: unknown) => {
        if (!value) return;
        if (typeof value === 'string') {
            parts.push(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) pushAddresses(item);
            return;
        }
        if (typeof value === 'object') {
            const record = value as { text?: unknown; address?: unknown; value?: unknown };
            if (typeof record.text === 'string') parts.push(record.text);
            if (typeof record.address === 'string') parts.push(record.address);
            if (record.value !== undefined) pushAddresses(record.value);
        }
    };

    pushAddresses(message.to);
    pushAddresses(message.cc);
    pushAddresses(message.envelope?.to);
    pushAddresses(message.envelope?.cc);
    for (const header of ['delivered-to', 'x-original-to', 'x-forwarded-to', 'resent-to']) {
        const value = message.headers?.get?.(header);
        if (value == null) continue;
        pushAddresses(value);
    }
    return parts.join(' ').toLowerCase();
}

export function messageMatchesRecipient(recipientText: string, recipientEmail: string): boolean {
    return recipientText.includes(recipientEmail.trim().toLowerCase());
}

function classifyImapError(credentials: OutlookCredentials, stage: string, error: any): Error {
    const message = String(error?.message ?? error);
    const response = `${error?.responseText ?? ''} ${message}`;
    const responseStatus = String(error?.responseStatus ?? '').toUpperCase();
    if (/AUTHENTICATIONFAILED|authentication failed|login failed/i.test(response)
        || (stage === 'imap_connect' && responseStatus === 'NO'))
        return preflightError(credentials, stage, 'imap_authentication_failed', error, false, '确认 token 包含 IMAP.AccessAsUser.All 权限且邮箱允许 IMAP');
    if (/permission|not permitted|denied|authorization/i.test(response))
        return preflightError(credentials, stage, 'imap_permission_denied', error, false, '为应用授予 IMAP.AccessAsUser.All 权限后重新授权');
    if (/mailbox|folder|NONEXISTENT/i.test(response))
        return preflightError(credentials, stage, 'imap_mailbox_unavailable', error, false, '确认 Outlook 收件箱可访问');
    const network = classifyNetworkError(error);
    return preflightError(credentials, stage, network.category, error, network.retryable, network.action);
}

export async function preflightOutlook(credentials: OutlookCredentials): Promise<void> {
    if (!/^\S+@\S+\.\S+$/.test(credentials.email) || !credentials.clientId.trim() || !credentials.refreshToken.trim())
        throw preflightError(credentials, 'input_validation', 'invalid_input', new Error('邮箱、client_id 或 refresh_token 格式无效'), false, '修正账号输入格式');
    if (credentials.mailboxEmail && !/^\S+@\S+\.\S+$/.test(credentials.mailboxEmail))
        throw preflightError(credentials, 'input_validation', 'invalid_mailbox_email', new Error('转发邮箱格式无效'), false, '修正 forwarding_emails / FORWARD_MAILBOXES');

    const accessToken = await getAccessToken(credentials);
    const client = createClient(credentials, accessToken);
    try {
        try {
            await client.connect();
        }
        catch (error) {
            throw classifyImapError(credentials, 'imap_connect', error);
        }

        try {
            const mailboxes = await client.list();
            const inbox = mailboxes.find(box => box.specialUse === '\\Inbox' || /^inbox$/i.test(box.path));
            if (!inbox)
                throw new Error('Inbox mailbox was not listed');
            const lock = await client.getMailboxLock(inbox.path);
            try {
                await client.search({ all: true });
            }
            finally {
                lock.release();
            }
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith('OUTLOOK_PREFLIGHT '))
                throw error;
            throw classifyImapError(credentials, 'imap_mailbox_read', error);
        }
    }
    finally {
        await client.logout().catch(() => undefined);
    }
    if (credentials.mailboxEmail)
        logger.info('Outlook OAuth2/IMAP 预检成功：转发箱 %s，按收件人过滤 %s', maskEmail(credentials.mailboxEmail), maskEmail(credentials.email));
    else
        logger.info('Outlook OAuth2/IMAP 预检成功：%s', maskEmail(credentials.email));
}

function decodeHtmlUrl(value: string): string {
    return value.replace(/&amp;/g, '&').replace(/&#x3D;/gi, '=').replace(/&#61;/g, '=');
}

function htmlToVisibleText(html: string): string {
    return html
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;|&#34;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
        .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
        .replace(/\s+/g, ' ')
        .trim();
}

function plausibleCode(code: string | undefined): code is string {
    return Boolean(code && !/^(\d)\1{5}$/.test(code));
}

function findContextualCode(value: string): string | undefined {
    const label = '(?:verification\\s+code|security\\s+code|one[- ]time\\s+(?:code|password)|验证码|驗證碼|ChatGPT|OpenAI|code)';
    const afterLabel = value.match(new RegExp(`${label}[^\\d]{0,80}(\\d{6})`, 'i'))?.[1];
    if (plausibleCode(afterLabel)) return afterLabel;
    const beforeLabel = value.match(new RegExp(`(\\d{6})[^\\d]{0,80}${label}`, 'i'))?.[1];
    return plausibleCode(beforeLabel) ? beforeLabel : undefined;
}

export function extractVerification(subject: string, text: string, html: string): ChatGptVerification | undefined {
    const urls = [
        ...Array.from(html.matchAll(/href=["']([^"']+)["']/gi), match => decodeHtmlUrl(match[1])),
        ...Array.from(text.matchAll(/https?:\/\/[^\s<>"]+/gi), match => decodeHtmlUrl(match[0]))
    ];
    const verificationLink = urls.find(url =>
        /(?:auth\.openai\.com|openai\.com|chatgpt\.com)/i.test(url)
        && /(?:verify|verification|authorize|callback|token)/i.test(url)
    );
    if (verificationLink)
        return { type: 'link', value: verificationLink };

    const plainText = `${subject}\n${text}`;
    const code = findContextualCode(`${plainText}\n${htmlToVisibleText(html)}`)
        ?? Array.from(plainText.matchAll(/\b(\d{6})\b/g), match => match[1]).find(plausibleCode);
    return code ? { type: 'code', value: code } : undefined;
}

async function findVerificationInMailbox(
    client: ImapFlow,
    mailbox: string,
    receivedAfter: Date,
    recipientEmail?: string
): Promise<ChatGptVerification | undefined> {
    const lock = await client.getMailboxLock(mailbox);
    try {
        // search() returns sequence numbers by default. Request UIDs explicitly
        // because fetchOne() below also runs in UID mode.
        const ids = await client.search({ since: receivedAfter }, { uid: true });
        if (!ids || !ids.length)
            return undefined;

        for (const uid of ids.slice(-10).reverse()) {
            const message = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
            if (!message || !message.source)
                continue;

            const subject = message.envelope?.subject ?? '';
            const parsed = await simpleParser(message.source);
            const sender = parsed.from?.text ?? '';
            if (!/(?:openai|chatgpt)/i.test(`${subject} ${sender}`))
                continue;

            if (recipientEmail) {
                const recipientText = collectRecipientText({
                    envelope: message.envelope,
                    to: parsed.to,
                    cc: parsed.cc,
                    headers: parsed.headers
                });
                if (!messageMatchesRecipient(recipientText, recipientEmail))
                    continue;
            }

            const verification = extractVerification(
                subject,
                parsed.text ?? '',
                typeof parsed.html === 'string' ? parsed.html : ''
            );
            if (verification)
                return verification;
        }
    }
    finally {
        lock.release();
    }
}

export async function waitForChatGptVerification(
    credentials: OutlookCredentials,
    options: WaitForVerificationOptions
): Promise<ChatGptVerification> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const accessToken = await getAccessToken(credentials);
    const client = createClient(credentials, accessToken);

    await client.connect();
    try {
        const mailboxes = await client.list();
        const candidates = mailboxes
            .filter(box => box.specialUse === '\\Inbox' || box.specialUse === '\\Junk' || /^(inbox|junk|junk email)$/i.test(box.path))
            .map(box => box.path);
        const mailboxNames = [...new Set(candidates)];
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            for (const mailbox of mailboxNames) {
                const verification = await findVerificationInMailbox(
                    client,
                    mailbox,
                    options.receivedAfter,
                    credentials.mailboxEmail ? credentials.email : undefined
                );
                if (verification)
                    return verification;
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0)
                break;
            logger.info('尚未收到 ChatGPT 验证邮件，等待下一次轮询（剩余约 %d 秒）', Math.ceil(remainingMs / 1000));
            await Utility.waitForSeconds(Math.min(pollIntervalMs, remainingMs) / 1000);
        }

        throw new Error(`等待 ChatGPT 验证邮件超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    finally {
        await client.logout().catch(() => undefined);
    }
}
