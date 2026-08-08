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

const MAX_SESSION_ATTEMPTS = 3;
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

/** 构建 711Proxy 住宅 Sticky 代理：每次调用生成新 session，出口国家由 PROXY_REGION 决定 */
export function buildJapanStickyProxy(): ProxyConfig {
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

    return { host, port, server: `http://${host}:${port}`, username, password, session, region, sessTime };
}

/** 更换 sticky session（同账号同 region），让 711Proxy 分配新出口 IP */
export function rotateStickySession(proxy: ProxyConfig): void {
    proxy.session = String(randomInt(10_000_000, 100_000_000));
    proxy.username = proxy.username.replace(/-session-\d+-sessTime-/, `-session-${proxy.session}-sessTime-`);
}

/**
 * 生成 PAC：图片/字体/JS/CSS 等静态资源直连本机网络，其余（HTML/XHR 等）走住宅代理。
 * 注册只需出口 IP 像目标地区；静态资源不校验地理，直连可省住宅流量。
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
    axiosProxy: { protocol: 'http'; host: string; port: number; auth: { username: string; password: string } }
): Promise<number> {
    const response = await axios.request({
        method: 'GET',
        url: CHATGPT_API_PROBE_URL,
        timeout: 20_000,
        proxy: axiosProxy,
        maxRedirects: 5,
        // 任意 HTTP 响应都说明隧道已通；连接级失败才会抛错
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'stream',
        maxContentLength: 64 * 1024,
    });
    response.data?.destroy?.();
    return response.status;
}

/** 启动浏览器前预检：只测代理访问 ChatGPT API 是否可达；失败则换 sticky session 重试 */
export async function preflightProxy(proxy: ProxyConfig): Promise<void> {
    const axiosProxy = {
        protocol: 'http' as const,
        host: proxy.host,
        port: proxy.port,
        auth: { username: proxy.username, password: proxy.password },
    };
    let lastError = '';
    for (let sessionAttempt = 1; sessionAttempt <= MAX_SESSION_ATTEMPTS; sessionAttempt++) {
        axiosProxy.auth = { username: proxy.username, password: proxy.password };
        try {
            const status = await probeChatgptViaProxy(axiosProxy);
            logger.info('711Proxy 可用性预检通过：api.chatgpt.com/v1 status=%s session=%s attempt=%s',
                status, proxy.session, sessionAttempt);
            return;
        } catch (error) {
            lastError = axios.isAxiosError(error) ? error.message : String(error);
            if (sessionAttempt >= MAX_SESSION_ATTEMPTS) break;
            logger.warn('711Proxy 可用性预检失败：%s；更换 sticky session 重试 %s/%s',
                lastError, sessionAttempt + 1, MAX_SESSION_ATTEMPTS);
            rotateStickySession(proxy);
        }
    }
    throw new Error(`711Proxy 可用性预检失败：${lastError}`);
}
