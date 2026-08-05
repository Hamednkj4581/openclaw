import { randomInt } from 'crypto';
import axios from 'axios';
import logger from './logger.js';

export type ProxyConfig = {
    host: string;
    port: number;
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

    // rotgb = Residential GB；region-JP 决定出口国家，与 gateway 主机无关
    const host = (process.env.PROXY_HOST ?? 'us.rotgb.711proxy.com').trim();
    const port = Number(process.env.PROXY_PORT ?? 10000);
    const region = (process.env.PROXY_REGION ?? 'JP').trim().toUpperCase();
    const sessTime = Math.min(180, Math.max(5, Number(process.env.PROXY_SESS_TIME ?? 30)));
    // 8 位数字 session：相同值复用同一 IP；新值分配新 IP 并重新计时
    const session = String(randomInt(10_000_000, 100_000_000));
    // 文档格式：username-zone-custom-region-XX-session-(id)-sessTime-N
    const username = `${baseUser}-zone-custom-region-${region}-session-${session}-sessTime-${sessTime}`;

    return { host, port, server: `http://${host}:${port}`, username, password, session, region, sessTime };
}

/**
 * 生成 PAC：图片/字体/JS/CSS 等静态资源直连本机网络，其余（HTML/XHR 等）走日本代理。
 * 注册只需出口 IP 像日本；静态资源不校验地理，直连可省住宅流量。
 */
export function buildProxyPacUrl(proxy: Pick<ProxyConfig, 'host' | 'port'>): string {
    const pac = [
        'function FindProxyForURL(url, host) {',
        '  if (/\\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|css|js|map)(\\?|$)/i.test(url))',
        '    return "DIRECT";',
        `  return "PROXY ${proxy.host}:${proxy.port}";`,
        '}',
    ].join('\n');
    return `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(pac)}`;
}

/** 启动浏览器前预检：确认代理可达且出口国家匹配 */
export async function preflightProxy(proxy: ProxyConfig): Promise<void> {
    // 使用 request 而非 get：patches 会给 axios.get 注入 agent，可能绕过 proxy
    const { data } = await axios.request<{ ip?: string; country?: string; countryCode?: string }>({
        method: 'GET',
        url: 'https://ipinfo.io/json',
        timeout: 30_000,
        proxy: {
            protocol: 'http',
            host: proxy.host,
            port: proxy.port,
            auth: { username: proxy.username, password: proxy.password },
        },
    });
    const country = (data.country ?? data.countryCode ?? '').toUpperCase();
    logger.info('711Proxy 出口：ip=%s country=%s', data.ip ?? 'unknown', country || 'unknown');
    if (!country) throw new Error('711Proxy 预检未返回国家信息');
    if (country !== proxy.region)
        throw new Error(`711Proxy 出口国家为 ${country}，期望 ${proxy.region}（ip=${data.ip ?? 'unknown'}）`);
}
