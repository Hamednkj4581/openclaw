import { ChatGptVerification, extractVerification } from './outlookMail.js';

export interface WebMailCredentials {
    email: string;
    mailboxUrl: string;
}

/** 按取件链接域名拆分的网页邮箱适配器；后续新域名在此注册即可。 */
export interface WebMailHostAdapter {
    /** 适配器标识，便于日志 */
    id: string;
    /** 精确匹配的 hostname（小写）；空数组表示默认兜底 */
    hosts: string[];
    /** 从页面内容提取验证码/链接；无结果返回 undefined */
    extract(content: string, credentials: WebMailCredentials): ChatGptVerification | undefined;
}

function stripTags(value: string): string {
    return value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 通用：整页走 OpenAI 验证码/链接抽取 */
export const defaultWebMailAdapter: WebMailHostAdapter = {
    id: 'default',
    hosts: [],
    extract(content) {
        if (!/(?:openai|chatgpt)/i.test(content)) return undefined;
        return extractVerification('', '', content);
    }
};

/**
 * mail.ai1998.xyz：邮件卡片为 details.mail-card，含 .subject / .meta / .body。
 * 优先按卡片抽取，避免页面其它数字干扰。
 */
export const ai1998WebMailAdapter: WebMailHostAdapter = {
    id: 'mail.ai1998.xyz',
    hosts: ['mail.ai1998.xyz'],
    extract(content) {
        const cards = content.match(/<details\b[^>]*class="[^"]*\bmail-card\b[^"]*"[^>]*>[\s\S]*?<\/details>/gi)
            ?? content.match(/<div\b[^>]*class="[^"]*\bmail-card\b[^"]*"[^>]*>[\s\S]*?<\/div>\s*(?=<div\b[^>]*class="[^"]*\bmail-card\b|<\/section>|<\/div>\s*<div class="page-loading"|$)/gi)
            ?? [];

        for (const card of cards) {
            if (!/(?:openai|chatgpt)/i.test(card)) continue;
            const subject = card.match(/class="subject"[^>]*>([\s\S]*?)<\//i)?.[1] ?? '';
            const meta = card.match(/class="meta"[^>]*>([\s\S]*?)<\//i)?.[1] ?? '';
            const body = card.match(/<(pre|div)\b[^>]*class="[^"]*\bbody\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? '';
            const verification = extractVerification(
                stripTags(subject),
                stripTags(`${meta}\n${body}`),
                card
            );
            if (verification) return verification;
        }

        // 有 OpenAI 字样但卡片正则未命中时，回退整页解析
        return defaultWebMailAdapter.extract(content, { email: '', mailboxUrl: '' });
    }
};

/** 已注册适配器（默认兜底放最后） */
const WEB_MAIL_HOST_ADAPTERS: WebMailHostAdapter[] = [
    ai1998WebMailAdapter,
    defaultWebMailAdapter,
];

export function resolveWebMailAdapter(hostname: string): WebMailHostAdapter {
    const host = hostname.trim().toLowerCase();
    for (const adapter of WEB_MAIL_HOST_ADAPTERS) {
        if (!adapter.hosts.length) continue;
        if (adapter.hosts.some(item => item === host)) return adapter;
    }
    return defaultWebMailAdapter;
}

/** 供测试：列出已注册非默认适配器 */
export function listWebMailHostAdapters(): WebMailHostAdapter[] {
    return WEB_MAIL_HOST_ADAPTERS.filter(adapter => adapter.hosts.length > 0);
}
