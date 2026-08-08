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
    /** 原始链接序号（从 0 起），便于日志；711 账号模式固定为 0 */
    linkIndex: number;
    region: string;
    sessTime: number;
    /**
     * 是否允许更换 sticky session 重试。
     * 仅 711 账号拼装模式为 true；网页传入的静态代理链接为 false（失败直接报错）。
     */
    stickyRotate: boolean;
};

const MAX_SESSION_ATTEMPTS = 3;
const PROXY_PREFLIGHT_ATTEMPTS = 3;
const PROXY_PREFLIGHT_RETRY_MS = 2_000;
const PROXY_PROBE_TIMEOUT_MS = 5_000;
const CHATGPT_API_PROBE_URL = 'https://api.chatgpt.com/v1';

/** PAC 与抓取分析共用：静态资源扩展名直连，其余走代理 */
export const STATIC_ASSET_PATTERN = String.raw`\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|css|js|map)(\?|$)`;
export const STATIC_ASSET_URL_RE = new RegExp(STATIC_ASSET_PATTERN, 'i');

/** workflow 输入 enable_711_proxy / 环境变量 ENABLE_711_PROXY，默认关闭 */
export function is711ProxyEnabled(): boolean {
    return ['1', 'true'].includes((process.env.ENABLE_711_PROXY ?? 'false').toLowerCase());
}

/** 与 buildProxyPacUrl 规则一致，供 network 产物标注当前会走 DIRECT 还是 PROXY；代理关闭时一律 DIRECT */
export function pacRouteForUrl(url: string): 'DIRECT' | 'PROXY' {
    if (!is711ProxyEnabled()) return 'DIRECT';
    return STATIC_ASSET_URL_RE.test(url) ? 'DIRECT' : 'PROXY';
}

/** 解析多行/分号分隔的代理链接列表 */
export function parseProxyLinkList(value: string): string[] {
    return value
        .split(/(?:\r?\n|;)+/)
        .map(item => item.trim())
        .filter(Boolean);
}

/**
 * 按账号序号轮询分配代理：5 个 job、3 条链接 → 0,1,2,0,1。
 */
export function pickProxyLink(links: string[], accountIndex: number): { link: string; linkIndex: number } {
    if (!links.length) throw new Error('代理链接列表为空');
    const index = Number.isInteger(accountIndex) && accountIndex >= 0 ? accountIndex : 0;
    const linkIndex = index % links.length;
    return { link: links[linkIndex], linkIndex };
}

/**
 * 解析单条代理链接，支持：
 * - http://user:pass@host:port
 * - user:pass@host:port
 * - host:port:user:pass
 * - host:port
 */
export function parseProxyLink(raw: string, linkIndex = 0): ProxyConfig {
    const text = raw.trim();
    if (!text) throw new Error('代理链接为空');

    let host = '';
    let port = 0;
    let username = '';
    let password = '';

    if (/^https?:\/\//i.test(text)) {
        let url: URL;
        try {
            url = new URL(text);
        } catch {
            throw new Error('代理链接不是有效 URL');
        }
        if (!['http:', 'https:'].includes(url.protocol))
            throw new Error('代理链接仅支持 http/https');
        host = url.hostname;
        port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
        username = decodeURIComponent(url.username || '');
        password = decodeURIComponent(url.password || '');
    } else if (text.includes('@')) {
        // user:pass@host:port（711 等常见格式，用户名里可含大量连字符）
        const at = text.lastIndexOf('@');
        const userinfo = text.slice(0, at);
        const hostPort = text.slice(at + 1).trim();
        const userColon = userinfo.indexOf(':');
        if (userColon <= 0 || !hostPort) {
            throw new Error('代理链接格式应为 user:pass@host:port');
        }
        username = userinfo.slice(0, userColon);
        password = userinfo.slice(userColon + 1);
        const portColon = hostPort.lastIndexOf(':');
        if (portColon <= 0) {
            throw new Error('代理链接格式应为 user:pass@host:port');
        }
        host = hostPort.slice(0, portColon).trim();
        port = Number(hostPort.slice(portColon + 1));
    } else {
        const parts = text.split(':');
        if (parts.length === 2) {
            host = parts[0].trim();
            port = Number(parts[1]);
        } else if (parts.length >= 4) {
            host = parts[0].trim();
            port = Number(parts[1]);
            username = parts[2];
            password = parts.slice(3).join(':');
        } else {
            throw new Error('代理链接格式应为 http://user:pass@host:port、user:pass@host:port 或 host:port:user:pass');
        }
    }

    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535)
        throw new Error('代理链接主机或端口无效');

    const sessionMatch = username.match(/-session-(\d+)-sessTime-/i);
    const session = sessionMatch?.[1] ?? String(randomInt(10_000_000, 100_000_000));
    const sessTimeMatch = username.match(/-sessTime-(\d+)/i);
    const sessTime = sessTimeMatch ? Number(sessTimeMatch[1]) : 30;
    const regionMatch = username.match(/-region-([A-Za-z]{2})(?:-|$)/i);

    return {
        host,
        port,
        server: `http://${host}:${port}`,
        username,
        password,
        session,
        linkIndex,
        region: regionMatch?.[1]?.toUpperCase() ?? '',
        sessTime: Number.isFinite(sessTime) ? sessTime : 30,
        // 静态链接列表不换 sticky：失败即失败
        stickyRotate: false,
    };
}

/** 构建 711Proxy 住宅 Sticky：用账号密码 + 地区拼装用户名，可换 session 拿新出口 */
export function build711StickyProxyFromEnv(): ProxyConfig {
    const baseUser = process.env.PROXY_USERNAME?.trim();
    const password = process.env.PROXY_PASSWORD?.trim();
    if (!baseUser || !password) throw new Error('缺少 PROXY_USERNAME / PROXY_PASSWORD');

    // rotgb = Residential GB；region-XX 决定出口国家，与 gateway 主机无关
    const host = (process.env.PROXY_HOST ?? 'us.rotgb.711proxy.com').trim();
    const port = Number(process.env.PROXY_PORT ?? 10000);
    const region = (process.env.PROXY_REGION ?? 'JP').trim().toUpperCase() || 'JP';
    const sessTime = Math.min(180, Math.max(5, Number(process.env.PROXY_SESS_TIME ?? 30)));
    // 8 位数字 session：相同值复用同一 IP；新值分配新 IP 并重新计时
    const session = String(randomInt(10_000_000, 100_000_000));
    // 文档格式：username-zone-custom-region-XX-session-(id)-sessTime-N
    const username = `${baseUser}-zone-custom-region-${region}-session-${session}-sessTime-${sessTime}`;

    return {
        host,
        port,
        server: `http://${host}:${port}`,
        username,
        password,
        session,
        linkIndex: 0,
        region,
        sessTime,
        stickyRotate: true,
    };
}

/**
 * 从环境变量构建代理：优先 711 账号密码模式，否则按 PROXY_LINKS / PROXY_URL 分配静态链接。
 */
export function buildStickyProxyFromEnv(accountIndex = Number(process.env.WEB_ACCOUNT_INDEX || '0')): ProxyConfig {
    const username = process.env.PROXY_USERNAME?.trim();
    const password = process.env.PROXY_PASSWORD?.trim();
    if (username && password) {
        const proxy = build711StickyProxyFromEnv();
        logger.info('已启用 711Proxy 账号模式：region=%s session=%s sessTime=%smin',
            proxy.region, proxy.session, proxy.sessTime);
        return proxy;
    }

    const list = parseProxyLinkList(process.env.PROXY_LINKS || '');
    const single = (process.env.PROXY_URL || '').trim();
    const links = list.length ? list : (single ? [single] : []);
    if (!links.length) throw new Error('缺少 PROXY_USERNAME/PROXY_PASSWORD 或 PROXY_URL/PROXY_LINKS');
    const { link, linkIndex } = pickProxyLink(links, accountIndex);
    const proxy = parseProxyLink(link, linkIndex);
    logger.info('已分配代理链接 #%s（共 %s 条）给账号序号 %s', linkIndex + 1, links.length, accountIndex);
    return proxy;
}

/** @deprecated 兼容旧名：现为 711 账号或静态链接统一入口 */
export function buildJapanStickyProxy(): ProxyConfig {
    return buildStickyProxyFromEnv();
}

/** 更换 sticky session（仅 711 拼装用户名含 session 段时改写；静态链接模式不应调用） */
export function rotateStickySession(proxy: ProxyConfig): void {
    if (!proxy.stickyRotate) return;
    proxy.session = String(randomInt(10_000_000, 100_000_000));
    if (!/-session-\d+-sessTime-/i.test(proxy.username)) return;
    proxy.username = proxy.username.replace(/-session-\d+-sessTime-/i, `-session-${proxy.session}-sessTime-`);
}

/**
 * 生成 PAC：图片/字体/JS/CSS 等静态资源直连本机网络，其余（HTML/XHR 等）走住宅代理。
 */
export function buildProxyPacUrl(proxy: Pick<ProxyConfig, 'host' | 'port'>): string {
    const pac = [
        'function FindProxyForURL(url, host) {',
        `  if (/${STATIC_ASSET_PATTERN}/i.test(url))`,
        '    return "DIRECT";',
        `  return "PROXY ${proxy.host}:${proxy.port}";`,
        '}',
    ].join('\n');
    return `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(pac)}`;
}

/** 经代理探测 api.chatgpt.com：有 HTTP 响应即视为隧道可用（不校验地理） */
export async function probeChatgptViaProxy(
    axiosProxy: { protocol: 'http'; host: string; port: number; auth?: { username: string; password: string } }
): Promise<number> {
    const response = await axios.request({
        method: 'GET',
        url: CHATGPT_API_PROBE_URL,
        timeout: PROXY_PROBE_TIMEOUT_MS,
        proxy: axiosProxy,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'stream',
        maxContentLength: 64 * 1024,
    });
    response.data?.destroy?.();
    return response.status;
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动浏览器前预检：只测代理访问 ChatGPT API 是否可达。
 * 711 账号模式失败可换 sticky 重试；静态链接模式在同一 session 上重试若干次。
 */
export async function preflightProxy(proxy: ProxyConfig): Promise<void> {
    const axiosProxy: {
        protocol: 'http';
        host: string;
        port: number;
        auth?: { username: string; password: string };
    } = {
        protocol: 'http',
        host: proxy.host,
        port: proxy.port,
    };
    if (proxy.username || proxy.password) {
        axiosProxy.auth = { username: proxy.username, password: proxy.password };
    }

    const sessionAttempts = proxy.stickyRotate ? MAX_SESSION_ATTEMPTS : 1;
    let lastError = '';
    for (let sessionAttempt = 1; sessionAttempt <= sessionAttempts; sessionAttempt++) {
        if (proxy.username || proxy.password) {
            axiosProxy.auth = { username: proxy.username, password: proxy.password };
        }
        for (let probeAttempt = 1; probeAttempt <= PROXY_PREFLIGHT_ATTEMPTS; probeAttempt++) {
            try {
                const status = await probeChatgptViaProxy(axiosProxy);
                logger.info(
                    '代理可用性预检通过：api.chatgpt.com/v1 status=%s link=#%s session=%s/%s probe=%s/%s sticky=%s',
                    status, proxy.linkIndex + 1, sessionAttempt, sessionAttempts,
                    probeAttempt, PROXY_PREFLIGHT_ATTEMPTS, proxy.stickyRotate,
                );
                return;
            } catch (error) {
                lastError = axios.isAxiosError(error) ? error.message : String(error);
                if (probeAttempt < PROXY_PREFLIGHT_ATTEMPTS) {
                    logger.warn('代理可用性预检失败（probe %s/%s）：%s；%s 秒后重试',
                        probeAttempt, PROXY_PREFLIGHT_ATTEMPTS, lastError, PROXY_PREFLIGHT_RETRY_MS / 1000);
                    await sleep(PROXY_PREFLIGHT_RETRY_MS);
                }
            }
        }
        if (!proxy.stickyRotate || sessionAttempt >= sessionAttempts) break;
        logger.warn('代理可用性预检失败：%s；更换 sticky session 重试 %s/%s',
            lastError, sessionAttempt + 1, sessionAttempts);
        rotateStickySession(proxy);
    }
    throw new Error(`代理可用性预检失败：${lastError}`);
}
