import fs from 'fs';

/** Playwright/Puppeteer cookie 的最小字段，供 Cookie-Editor 导出 */
export type BrowserCookie = {
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    session?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None' | string;
};

export type CookieEditorItem = {
    domain: string;
    hostOnly: boolean;
    httpOnly: boolean;
    name: string;
    path: string;
    sameSite: string;
    secure: boolean;
    session: boolean;
    storeId: string;
    value: string;
    expirationDate?: number;
};

const SAMESITE_MAP: Record<string, string> = {
    Strict: 'strict',
    Lax: 'lax',
    None: 'no_restriction',
};

/** 转为 Cookie-Editor 扩展可导入的 JSON 条目（对齐 CursorCookie） */
export function toCookieEditorFormat(cookies: BrowserCookie[]): CookieEditorItem[] {
    return cookies.map(cookie => {
        const domain = cookie.domain || '';
        const expires = cookie.expires ?? -1;
        const session = cookie.session === true || expires === -1 || expires == null;
        const item: CookieEditorItem = {
            domain,
            hostOnly: !domain.startsWith('.'),
            httpOnly: Boolean(cookie.httpOnly),
            name: cookie.name || '',
            path: cookie.path || '/',
            sameSite: SAMESITE_MAP[cookie.sameSite ?? ''] ?? 'unspecified',
            secure: Boolean(cookie.secure),
            session,
            storeId: '0',
            value: cookie.value || '',
        };
        if (!session && typeof expires === 'number' && expires > 0)
            item.expirationDate = Math.trunc(expires);
        return item;
    });
}

/** 仅保留 ChatGPT / OpenAI 相关 cookie */
export function filterChatGptCookies(cookies: BrowserCookie[]): BrowserCookie[] {
    return cookies.filter(cookie => {
        const domain = cookie.domain || '';
        const name = cookie.name || '';
        return /chatgpt|openai/i.test(domain) || /chatgpt|openai|next-auth/i.test(name);
    });
}

/** 按邮箱生成 cookie 文件名（替换路径非法字符） */
export function cookieFileNameForEmail(email: string): string {
    const safe = email.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!safe) throw new Error('邮箱为空，无法生成 cookie 文件名');
    return `${safe}.json`;
}

export function writeCookieEditorJson(filePath: string, cookies: BrowserCookie[]): number {
    const filtered = filterChatGptCookies(cookies);
    const payload = toCookieEditorFormat(filtered.length ? filtered : cookies);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
    return payload.length;
}
