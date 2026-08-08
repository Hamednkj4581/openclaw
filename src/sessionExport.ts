import fs from 'fs';
import type { Page } from 'puppeteer';
import Utility from './Utility.js';
import logger from './logger.js';

/** /api/auth/session 导出结构（写入 session.json） */
export type SessionExport = {
    user: { id: string; email: string };
    expires: string;
    account: { id: string; planType: string };
    accessToken: string;
    sessionToken: string;
    authProvider: string;
};

/** session.json 中 account.planType 为 plus 时无需提链 */
export function isChatGptPlusPlan(planType: string | undefined): boolean {
    const normalized = (planType || '').trim().toLowerCase();
    return normalized === 'plus' || normalized.endsWith('plus');
}

/** 读取 next-auth session cookie；过长时会被拆成 .0/.1/... 分片，需按序号拼接 */
export function readSessionTokenFromCookies(cookies: Array<{ name: string; value: string }>): string | null {
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

export function writeSessionJson(session: SessionExport): void {
    const filePath = process.env.ACCOUNT_SESSION_JSON_PATH || 'session.json';
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n');
    logger.info('已导出 session JSON：%s（planType=%s）', filePath, session.account.planType);
}

export async function extractSessionExport(page: Page): Promise<SessionExport> {
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
            throw new Error(`提取 session 失败：${message}`);
        }
    }, { pollInterval: 500, timeout: 30_000 }).catch(() => {
        throw new Error('已登录但未能导出完整 session JSON（accessToken/sessionToken）');
    });
}
