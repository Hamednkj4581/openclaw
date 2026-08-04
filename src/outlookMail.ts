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

interface WaitForCodeOptions {
    receivedAfter: Date;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

async function getAccessToken(clientId: string, refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
    });

    const { data } = await axios.post(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        body,
        { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
    );

    if (!data.access_token)
        throw new Error(`Microsoft OAuth token 获取失败: ${data.error ?? '响应中没有 access_token'}`);

    return data.access_token;
}

function extractVerificationCode(subject: string, content: string): string | undefined {
    const combined = `${subject}\n${content}`;
    const contextual = combined.match(/(?:ChatGPT|OpenAI|代码|code)[^\d]{0,80}(\d{6})/i);
    return contextual?.[1] ?? combined.match(/\b(\d{6})\b/)?.[1];
}

async function findCodeInMailbox(client: ImapFlow, mailbox: string, receivedAfter: Date): Promise<string | undefined> {
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
            const relevant = /(?:openai|chatgpt)/i.test(`${subject} ${sender}`);
            if (!relevant)
                continue;

            const content = `${parsed.text ?? ''}\n${parsed.html || ''}`;
            const code = extractVerificationCode(subject, content);
            if (code)
                return code;
        }
    }
    finally {
        lock.release();
    }
}

export async function waitForChatGptCode(
    credentials: OutlookCredentials,
    options: WaitForCodeOptions
): Promise<string> {
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
                const code = await findCodeInMailbox(client, mailbox, options.receivedAfter);
                if (code)
                    return code;
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
