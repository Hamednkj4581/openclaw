import { randomInt } from 'crypto';

export type ProxyConfig = {
    server: string;
    username: string;
    password: string;
    session: string;
    region: string;
    sessTime: number;
};

/** 构建 711Proxy 日本住宅 Sticky 代理：每次调用生成新 session，IP 与计时均重新开始 */
export function buildJapanStickyProxy(): ProxyConfig {
    const baseUser = process.env.PROXY_USERNAME?.trim();
    const password = process.env.PROXY_PASSWORD?.trim();
    if (!baseUser || !password) throw new Error('缺少 PROXY_USERNAME / PROXY_PASSWORD');

    const host = (process.env.PROXY_HOST ?? 'as.711proxy.com').trim();
    const port = Number(process.env.PROXY_PORT ?? 10000);
    const region = (process.env.PROXY_REGION ?? 'JP').trim().toUpperCase();
    const sessTime = Math.min(180, Math.max(5, Number(process.env.PROXY_SESS_TIME ?? 30)));
    // 8 位数字 session：相同值复用同一 IP；新值分配新 IP 并重新计时
    const session = String(randomInt(10_000_000, 100_000_000));
    const username = `${baseUser}-region-${region}-session-${session}-sessTime-${sessTime}`;

    return { server: `http://${host}:${port}`, username, password, session, region, sessTime };
}
