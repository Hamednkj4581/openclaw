import axios from 'axios';
import fs from 'fs';
import logger from './logger.js';

const OAI9_BASE = 'https://long.oai9.com';
const PROMO_CHECK_URL = `${OAI9_BASE}/api/promo-coupon/check`;
const GCASH_TASKS_URL = `${OAI9_BASE}/api/gcash-link/tasks`;
const CARD_QUERY_URL = `${OAI9_BASE}/api/card`;

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120;

type ProgressFn = (message: string) => Promise<void>;

function pickPaymentLink(task: Record<string, unknown>): string {
    for (const key of ['gcash_url', 'provider_redirect_url', 'long_url'] as const) {
        const value = task[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

async function httpJson(url: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
        const response = payload
            ? await axios.post(url, payload, { timeout: 60_000, validateStatus: () => true })
            : await axios.get(url, { timeout: 60_000, validateStatus: () => true });
        const data = response.data;
        if (response.status >= 400) {
            const detail = data && typeof data === 'object' ? (data as any).detail ?? (data as any).error : null;
            if (typeof detail === 'string' && detail.trim()) throw new Error(detail.trim());
            if (detail && typeof detail === 'object' && detail.error) throw new Error(String(detail.error));
            if (data && typeof data === 'object' && (data as any).error) throw new Error(String((data as any).error));
            throw new Error(`HTTP ${response.status}`);
        }
        if (!data || typeof data !== 'object') throw new Error('响应格式无效');
        return data as Record<string, unknown>;
    } catch (error) {
        if (axios.isAxiosError(error) && !error.response) {
            throw new Error(error.message || '网络错误');
        }
        throw error;
    }
}

async function queryCard(card: string): Promise<Record<string, unknown>> {
    return httpJson(CARD_QUERY_URL, { card });
}

/** 资格检查结果（供 Actions 日志定位跳过原因） */
type EligibilityResult = {
    ok: boolean;
    state: string;
    eligible: boolean;
    error: string;
};

async function checkTokenEligibility(token: string): Promise<EligibilityResult> {
    const payload = await httpJson(PROMO_CHECK_URL, { accessTokens: [token] });
    const results = payload.results;
    if (!Array.isArray(results) || !results[0] || typeof results[0] !== 'object') {
        return { ok: false, state: '', eligible: false, error: '资格接口无结果' };
    }
    const row = results[0] as Record<string, unknown>;
    const state = typeof row.state === 'string' ? row.state : '';
    const eligible = Boolean(row.eligible);
    const error = row.error != null ? String(row.error) : '';
    if (error) return { ok: false, state, eligible: false, error };
    return {
        ok: state === 'eligible' && eligible,
        state: state || (eligible ? 'eligible' : 'ineligible'),
        eligible,
        error: '',
    };
}

async function submitGcashTask(card: string, token: string): Promise<string[]> {
    const payload = await httpJson(GCASH_TASKS_URL, {
        card,
        accessTokens: [token],
        plan_type: 'plus',
        promo_code: '',
    });
    const jobIds: string[] = [];
    for (const key of ['tasks', 'active_duplicates'] as const) {
        const rows = payload[key];
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const jobId = (row as Record<string, unknown>).job_id;
            if (typeof jobId === 'string' && jobId.trim()) jobIds.push(jobId.trim());
        }
    }
    return [...new Set(jobIds)];
}

async function fetchTaskStatuses(jobIds: string[]): Promise<Record<string, unknown>[]> {
    const tasks: Record<string, unknown>[] = [];
    for (let index = 0; index < jobIds.length; index += 50) {
        const batch = jobIds.slice(index, index + 50);
        const query = new URLSearchParams({ job_ids: batch.join(',') });
        const payload = await httpJson(`${GCASH_TASKS_URL}/statuses?${query}`);
        const rows = payload.tasks;
        if (Array.isArray(rows)) {
            for (const row of rows) {
                if (row && typeof row === 'object') tasks.push(row as Record<string, unknown>);
            }
        }
    }
    return tasks;
}

async function pollGcashLink(jobIds: string[], onProgress: ProgressFn): Promise<string> {
    const pending = new Set(jobIds);
    let link = '';
    let failed = 0;

    logger.info('开始轮询提链任务：job=%s，最多 %s 次、间隔 %ss', jobIds.join(','), POLL_MAX_ATTEMPTS, POLL_INTERVAL_MS / 1000);

    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
        const rows = await fetchTaskStatuses([...pending].sort());
        for (const row of rows) {
            const jobId = String(row.job_id || '').trim();
            if (!jobId || !pending.has(jobId)) continue;
            const status = String(row.status || '').trim().toLowerCase();
            if (status === 'queued' || status === 'extracting' || !status) continue;
            pending.delete(jobId);
            if (status === 'done') {
                const picked = pickPaymentLink(row);
                if (picked) {
                    link = picked;
                    logger.info('提链任务完成：%s status=done，已拿到链接', jobId);
                } else {
                    failed += 1;
                    logger.warn('提链任务完成但无链接字段：%s keys=%s', jobId, Object.keys(row).join(','));
                }
            } else {
                failed += 1;
                const err = row.error != null ? String(row.error) : '';
                logger.warn('提链任务结束：%s status=%s%s', jobId, status || '?', err ? ` error=${err}` : '');
            }
        }

        if (attempt === 1 || attempt % 6 === 0) {
            const statuses = rows
                .map((row) => `${String(row.job_id || '?').slice(0, 8)}…=${String(row.status || '?')}`)
                .join(', ');
            logger.info(
                '提链轮询中：第 %s/%s 次，待完成=%s%s',
                attempt,
                POLL_MAX_ATTEMPTS,
                pending.size,
                statuses ? `，状态=[${statuses}]` : '',
            );
            await onProgress(pending.size ? '正在等待支付链接生成，请稍候…' : '支付链接即将就绪…');
        }
        if (!pending.size) break;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (pending.size) {
        logger.warn('提链轮询超时，未完成任务数：%s，job=%s', pending.size, [...pending].join(','));
        failed += pending.size;
    }
    if (!link) {
        throw new Error(failed ? '支付链接生成失败' : '未拿到支付链接');
    }
    return link;
}

/** 是否启用单账号 GCash 提链 */
export function isPaymentLinkEnabled(): boolean {
    return (process.env.PAYMENT_LINK_TYPE || '').trim() === 'gcash';
}

/** 单账号提链结果：成功带 link；失败/跳过带 error（给客户端展示） */
export type PaymentLinkResult = {
    link?: string;
    error?: string;
};

function formatEligibilitySkip(eligibility: EligibilityResult): string {
    const parts = [`state=${eligibility.state || '?'}`];
    if (eligibility.error) parts.push(eligibility.error);
    else parts.push(`eligible=${eligibility.eligible}`);
    return `暂无支付资格（${parts.join('，')}）`;
}

/**
 * 当前账号单独提链；失败只告警，不抛出（不影响注册/登录成功）。
 */
export async function extractAccountPaymentLink(
    accessToken: string,
    onProgress: ProgressFn = async () => undefined
): Promise<PaymentLinkResult> {
    const linkType = (process.env.PAYMENT_LINK_TYPE || '').trim();
    if (!isPaymentLinkEnabled()) {
        logger.info('未启用 GCash 提链（PAYMENT_LINK_TYPE=%s），跳过', linkType || '空');
        return {};
    }
    const card = (process.env.PAYMENT_CARD || '').trim();
    if (!card) {
        const tip = '未配置支付卡密，已跳过提链';
        logger.warn('已选择 gcash 但未提供卡密，跳过提链');
        await onProgress(tip);
        return { error: tip };
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::add-mask::${card}`);
        console.log(`::add-mask::${accessToken}`);
    }

    logger.info('开始单账号 GCash 提链');
    try {
        await onProgress('正在检查支付资格…');
        logger.info('正在查询卡密可用性…');
        const cardInfo = await queryCard(card);
        if (!cardInfo.ok || !cardInfo.exists) {
            throw new Error(String(cardInfo.error || '卡密不可用'));
        }
        logger.info('卡密可用，正在检查账号支付资格…');

        const eligibility = await checkTokenEligibility(accessToken);
        logger.info(
            '支付资格结果：ok=%s state=%s eligible=%s%s',
            eligibility.ok,
            eligibility.state || '?',
            eligibility.eligible,
            eligibility.error ? ` error=${eligibility.error}` : '',
        );
        if (!eligibility.ok) {
            const tip = formatEligibilitySkip(eligibility);
            logger.warn('当前账号暂无支付资格，已跳过提链：%s', tip);
            await onProgress(tip);
            return { error: tip };
        }

        await onProgress('正在创建支付链接…');
        logger.info('正在创建 GCash 提链任务…');
        const jobIds = await submitGcashTask(card, accessToken);
        if (!jobIds.length) throw new Error('未创建提链任务');
        logger.info('已创建提链任务：%s', jobIds.join(','));

        await onProgress('正在等待支付链接生成，请稍候…');
        const link = await pollGcashLink(jobIds, onProgress);
        fs.writeFileSync('payment-link.txt', `${link}\n`, 'utf8');
        await onProgress('支付链接已就绪');
        let host = '';
        try {
            host = new URL(link).host;
        } catch {
            host = '(无法解析)';
        }
        logger.info('单账号提链成功：host=%s length=%s', host, link.length);
        return { link };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const tip = `支付链接生成失败：${message}`;
        logger.warn('单账号提链失败（不影响主流程）：%s', message);
        await onProgress(tip).catch(() => undefined);
        return { error: tip };
    }
}

export { pickPaymentLink };
