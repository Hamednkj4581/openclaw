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

const GEO_ENDPOINTS = [
    'https://ipinfo.io/json',
    'http://ip-api.com/json/?fields=status,country,countryCode,query',
    'https://ipapi.co/json/',
] as const;

const MAX_SESSION_ATTEMPTS = 3;

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

/** 更换 sticky session（同账号同 region），让 711Proxy 分配新出口 IP */
export function rotateStickySession(proxy: ProxyConfig): void {
    proxy.session = String(randomInt(10_000_000, 100_000_000));
    proxy.username = proxy.username.replace(/-session-\d+-sessTime-/, `-session-${proxy.session}-sessTime-`);
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

type GeoLookup = { ip?: string; country?: string; countryCode?: string; country_code?: string; query?: string };

/** 优先取 ISO 两位码（ip-api 的 country 是全名，不能直接用） */
export function geoFromPayload(data: GeoLookup): { ip: string; country: string } {
    const code = (data.countryCode ?? data.country_code ?? '').toUpperCase();
    const raw = (data.country ?? '').toUpperCase();
    const country = code || (/^[A-Z]{2}$/.test(raw) ? raw : '');
    const ip = data.ip ?? data.query ?? 'unknown';
    return { ip, country };
}

async function lookupGeoVia(
    url: string,
    axiosProxy: { protocol: 'http'; host: string; port: number; auth: { username: string; password: string } }
): Promise<{ ip: string; country: string; host: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            // 使用 request 而非 get：patches 会给 axios.get 注入 agent，可能绕过 proxy
            const { data } = await axios.request<GeoLookup>({ method: 'GET', url, timeout: 30_000, proxy: axiosProxy });
            const { ip, country } = geoFromPayload(data);
            return { ip, country, host: new URL(url).host };
        } catch (error) {
            lastError = error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (status === 429 && attempt < 2) {
                await new Promise(r => setTimeout(r, 1500 * attempt));
                continue;
            }
            throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 多源交叉核对出口国家：单源可能误标；仅当有效结果均非目标国时判定不匹配。
 * 任一侧报目标国则放行（冲突时打警告）。
 */
export function decideProxyRegion(
    expected: string,
    samples: Array<{ ip: string; country: string; host: string }>
): { ok: boolean; ip: string; countries: string[]; detail: string } {
    const valid = samples.filter(s => s.country);
    if (!valid.length) return { ok: false, ip: 'unknown', countries: [], detail: '711Proxy 预检未返回国家信息' };
    const ip = valid.find(s => s.ip !== 'unknown')?.ip ?? valid[0].ip;
    const countries = [...new Set(valid.map(s => s.country))];
    const matched = valid.filter(s => s.country === expected);
    if (matched.length) {
        if (countries.length > 1) {
            const conflict = valid.map(s => `${s.host}=${s.country}`).join(', ');
            return { ok: true, ip, countries, detail: `地理库冲突但含 ${expected}，放行（${conflict}）` };
        }
        return { ok: true, ip, countries, detail: `${matched[0].host}=${expected}` };
    }
    const summary = valid.map(s => `${s.host}=${s.country}`).join(', ');
    return { ok: false, ip, countries, detail: `出口国家为 ${countries.join('/')}，期望 ${expected}（ip=${ip}；${summary}）` };
}

/** 启动浏览器前预检：多源核对出口国；确认非目标国则换 sticky session 重试 */
export async function preflightProxy(proxy: ProxyConfig): Promise<void> {
    const axiosProxy = {
        protocol: 'http' as const,
        host: proxy.host,
        port: proxy.port,
        auth: { username: proxy.username, password: proxy.password },
    };
    let lastMismatch = '';
    for (let sessionAttempt = 1; sessionAttempt <= MAX_SESSION_ATTEMPTS; sessionAttempt++) {
        axiosProxy.auth = { username: proxy.username, password: proxy.password };
        const samples: Array<{ ip: string; country: string; host: string }> = [];
        for (const url of GEO_ENDPOINTS) {
            try {
                const sample = await lookupGeoVia(url, axiosProxy);
                logger.info('711Proxy 出口：ip=%s country=%s via=%s session=%s attempt=%s',
                    sample.ip, sample.country || 'unknown', sample.host, proxy.session, sessionAttempt);
                samples.push(sample);
            } catch (error) {
                logger.warn('711Proxy 预检失败：%s attempt=%s %s', new URL(url).host, sessionAttempt,
                    axios.isAxiosError(error) ? `${error.response?.status ?? ''} ${error.message}` : String(error));
            }
        }
        const decision = decideProxyRegion(proxy.region, samples);
        if (decision.ok) {
            if (/冲突/.test(decision.detail)) logger.warn('711Proxy 预检：%s', decision.detail);
            else logger.info('711Proxy 预检通过：%s', decision.detail);
            return;
        }
        lastMismatch = decision.detail || '711Proxy 预检失败';
        if (!samples.some(s => s.country)) {
            throw new Error(lastMismatch.startsWith('711Proxy') ? lastMismatch : `711Proxy 预检失败：${lastMismatch}`);
        }
        if (sessionAttempt >= MAX_SESSION_ATTEMPTS) break;
        logger.warn('711Proxy %s；更换 sticky session 重试 %s/%s', lastMismatch, sessionAttempt + 1, MAX_SESSION_ATTEMPTS);
        rotateStickySession(proxy);
    }
    throw new Error(`711Proxy ${lastMismatch}`);
}
