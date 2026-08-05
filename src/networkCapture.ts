import fs from 'fs';
import path from 'path';
import type { HTTPRequest, Page } from 'puppeteer';
import logger from './logger.js';
import { pacRouteForUrl } from './proxy.js';

export type NetworkRecord = {
    method: string;
    resourceType: string;
    pac: 'DIRECT' | 'PROXY';
    host: string;
    url: string;
};

/** 去掉 query/hash，避免验证码、token 等敏感参数进入产物；仍保留主机与路径便于分析代理范围 */
export function sanitizeNetworkUrl(raw: string, redact: (text: string) => string): { host: string; url: string } | null {
    if (!/^https?:\/\//i.test(raw)) return null;
    try {
        const parsed = new URL(raw);
        return { host: parsed.host, url: redact(`${parsed.protocol}//${parsed.host}${parsed.pathname}`) };
    } catch {
        return null;
    }
}

export function formatNetworkUrlLog(records: NetworkRecord[]): string {
    const lines = ['# seq\tmethod\tresourceType\tpac\turl', ...records.map((r, i) =>
        `${i + 1}\t${r.method}\t${r.resourceType}\t${r.pac}\t${r.url}`)];
    return `${lines.join('\n')}\n`;
}

/** 按主机汇总：便于筛出仍走 PROXY、可考虑直连的域名 */
export function formatNetworkHostSummary(records: NetworkRecord[]): string {
    const byHost = new Map<string, { total: number; proxy: number; direct: number; types: Set<string> }>();
    for (const r of records) {
        const row = byHost.get(r.host) ?? { total: 0, proxy: 0, direct: 0, types: new Set<string>() };
        row.total += 1;
        if (r.pac === 'PROXY') row.proxy += 1;
        else row.direct += 1;
        row.types.add(r.resourceType);
        byHost.set(r.host, row);
    }
    const rows = [...byHost.entries()]
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
        .map(([host, s]) => `${s.total}\t${s.proxy}\t${s.direct}\t${[...s.types].sort().join(',')}\t${host}`);
    return `${['# count\tproxy\tdirect\tresourceTypes\thost', ...rows].join('\n')}\n`;
}

/**
 * 监听页面全部 HTTP(S) 请求，结束时写入 evidence，用于分析哪些流量不必走住宅代理。
 * pac 列按当前 PAC 规则标注（扩展名直连 / 其余代理），与真实走线一致。
 */
export function installNetworkCapture(page: Page, redact: (text: string) => string) {
    const records: NetworkRecord[] = [];
    const onRequest = (request: HTTPRequest) => {
        const parsed = sanitizeNetworkUrl(request.url(), redact);
        if (!parsed) return;
        records.push({
            method: request.method(),
            resourceType: request.resourceType(),
            pac: pacRouteForUrl(request.url()),
            host: parsed.host,
            url: parsed.url,
        });
    };
    page.on('request', onRequest);
    return {
        records,
        flush(dir = './evidence') {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'network-urls.tsv'), formatNetworkUrlLog(records));
            fs.writeFileSync(path.join(dir, 'network-hosts.tsv'), formatNetworkHostSummary(records));
            const hosts = new Set(records.map(r => r.host)).size;
            const proxied = records.filter(r => r.pac === 'PROXY').length;
            logger.info('网络流量已写入 evidence（请求 %s，主机 %s，当前 PAC 标为 PROXY %s）',
                records.length, hosts, proxied);
        },
    };
}
