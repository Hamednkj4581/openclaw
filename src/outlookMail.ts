import axios from 'axios';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Utility from './Utility.js';
import logger from './logger.js';

interface OutlookCredentials {
    email: string;
    clientId: string;
    refreshToken: string;
}

interface WaitForVerificationOptions {
    receivedAfter: Date;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

export type ChatGptVerification =
    | { type: 'code'; value: string }
    | { type: 'link'; value: string };

async function getAccessToken(clientId: string, refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
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
            const description = error.response?.data?.error_description ?? error.message;
            throw new Error(`Microsoft OAuth token 获取失败: ${code} ${description}`);
        }
        throw error;
    }
}

function decodeHtmlUrl(value: string): string {
    return value.replace(/&amp;/g, '&').replace(/&#x3D;/gi, '=').replace(/&#61;/g, '=');
}

function extractVerification(subject: string, text: string, html: string): ChatGptVerification | undefined {
    const combined = `${subject}\n${text}\n${html}`;
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

    const contextual = combined.match(/(?:ChatGPT|OpenAI|代码|code)[^\d]{0,80}(\d{6})/i);
    const code = contextual?.[1] ?? combined.match(/\b(\d{6})\b/)?.[1];
    return code ? { type: 'code', value: code } : undefined;
}

async function findVerificationInMailbox(
    client: ImapFlow,
    mailbox: string,
    receivedAfter: Date
): Promise<ChatGptVerification | undefined> {
    const lock = await client.getMailboxLock(mailbox);
    try {
        const ids = await client.search({ since: receivedAfter });
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
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const accessToken = await getAccessToken(credentials.clientId, credentials.refreshToken);
    const client = new ImapFlow({
        host: 'outlook.live.com',
        port: 993,
        secure: true,
        auth: { user: credentials.email, accessToken },
        logger: false
    });

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
                const verification = await findVerificationInMailbox(client, mailbox, options.receivedAfter);
                if (verification)
                    return verification;
            }

            logger.info('尚未收到 ChatGPT 验证邮件，等待下一次轮询');
            await Utility.waitForSeconds(pollIntervalMs / 1000);
        }

        throw new Error(`等待 ChatGPT 验证邮件超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    finally {
        await client.logout().catch(() => undefined);
    }
}
