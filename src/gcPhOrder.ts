import logger from './logger.js';

const GC_PH_BASE = 'https://kakaopay.art';
const UPLOAD_URL = `${GC_PH_BASE}/api/v1/partner/gc-ph/order-batches/images`;
const ORDER_URL = `${GC_PH_BASE}/api/v1/partner/gc-ph/orders`;

/** 上传失败后的原幂等重试间隔（秒） */
const UPLOAD_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
/** 订单轮询：前期更勤，后期放宽 */
const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 15_000;
const POLL_FAST_UNTIL_MS = 5 * 60_000;
/** 文档时效约 17 分钟，这里略放宽 */
const POLL_MAX_MS = 18 * 60_000;

type ProgressFn = (message: string) => Promise<void>;

type ApiEnvelope = {
    ok?: boolean;
    request_id?: string;
    error_code?: string;
    message?: string;
    retryable?: boolean;
    data?: Record<string, unknown>;
};

export type GcPhSubmitResult = {
    /** 是否已进入对方流程（上传被接受或幂等重放） */
    submitted: boolean;
    /** 轮询到的终态（有则表示已结束） */
    state?: string;
    /** 给网页端的友好说明；失败时必有 */
    tip?: string;
};

const TERMINAL_STATES = new Set([
    'unverified_completed',
    'manual_settled',
    'expired',
    'failed',
]);

/** 是否配置了菲律宾通道密钥（未配置则整段跳过） */
export function isGcPhEnabled(): boolean {
    return Boolean((process.env.GC_PH_API_KEY || '').trim());
}

function apiKey(): string {
    return (process.env.GC_PH_API_KEY || '').trim();
}

/** 客户订单号：任务 ID + 账号序号，保证同任务内唯一 */
export function buildExternalOrderId(): string {
    const taskId = (process.env.WEB_TASK_ID || '').trim() || 'local';
    const indexRaw = (process.env.WEB_ACCOUNT_INDEX || '0').trim();
    const index = /^\d+$/.test(indexRaw) ? indexRaw : '0';
    const id = `gfr-${taskId}-${index}`;
    return id.slice(0, 160);
}

function buildIdempotencyKey(externalOrderId: string): string {
    return `gc-ph-img-${externalOrderId}`.slice(0, 160);
}

function dataUrlToPngBytes(dataUrl: string): Buffer {
    const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl.trim());
    if (!match?.[1]) throw new Error('二维码图片格式无效');
    const bytes = Buffer.from(match[1], 'base64');
    if (!bytes.length) throw new Error('二维码图片为空');
    // 文档默认单图不超过 2 MiB
    if (bytes.length > 2 * 1024 * 1024) throw new Error('二维码图片过大');
    return bytes;
}

function friendlyUploadTip(errorCode: string, httpStatus: number): string {
    const code = errorCode.trim().toLowerCase();
    if (code === 'quota_insufficient') return '支付通道次数不足，二维码未能提交';
    if (code === 'duplicate_qr_asset') return '该支付二维码已提交过，请勿重复操作';
    if (code === 'duplicate_external_order_id') return '本单已提交过支付二维码';
    if (code === 'invalid_qr_asset' || code === 'request_too_large') {
        return '支付二维码图片不符合要求，未能提交';
    }
    if (httpStatus === 401) return '支付通道密钥无效，未能提交二维码';
    if (httpStatus === 429) return '支付通道繁忙，请稍后重试';
    if (httpStatus >= 500) return '支付通道暂时不可用，请稍后重试';
    return '支付二维码提交失败，请稍后重试';
}

function friendlyStateTip(state: string): string {
    switch (state) {
        case 'waiting':
            return '支付二维码已提交，等待处理…';
        case 'claimed':
            return '支付订单处理中，请稍候…';
        case 'unverified_completed':
            return '支付已提交，等待确认…';
        case 'manual_settled':
            return '支付处理已完成';
        case 'expired':
            return '支付订单已过期';
        case 'failed':
            return '支付处理失败';
        default:
            return '支付订单处理中，请稍候…';
    }
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseEnvelope(response: Response): Promise<ApiEnvelope> {
    try {
        const data = (await response.json()) as ApiEnvelope;
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

async function uploadOnce(
    key: string,
    externalOrderId: string,
    idempotencyKey: string,
    pngBytes: Buffer,
): Promise<{ httpStatus: number; body: ApiEnvelope }> {
    const form = new FormData();
    form.append('external_order_ids', JSON.stringify([externalOrderId]));
    form.append('images', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'qr.png');

    const response = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${key}`,
            'Idempotency-Key': idempotencyKey,
        },
        body: form,
        signal: AbortSignal.timeout(90_000),
    });
    const body = await parseEnvelope(response);
    return { httpStatus: response.status, body };
}

function itemAccepted(body: ApiEnvelope): boolean {
    const data = body.data;
    if (!data || typeof data !== 'object') return false;
    const items = data.items;
    if (!Array.isArray(items) || !items[0] || typeof items[0] !== 'object') {
        // 无 items 时看批次 status
        const status = String(data.status || '').toLowerCase();
        return status === 'accepted' || status === 'partial';
    }
    const item = items[0] as Record<string, unknown>;
    return String(item.result || '').toLowerCase() === 'accepted';
}

function itemRejectionCode(body: ApiEnvelope): string {
    const data = body.data;
    if (!data || typeof data !== 'object') return '';
    const items = data.items;
    if (!Array.isArray(items) || !items[0] || typeof items[0] !== 'object') return '';
    const item = items[0] as Record<string, unknown>;
    return String(item.rejection_code || '').trim();
}

/**
 * 上传截屏二维码；网络/可重试错误用原幂等键退避重试。
 * 成功（含幂等重放）返回 true；业务拒绝返回友好 tip。
 */
async function uploadQrImage(
    key: string,
    externalOrderId: string,
    pngBytes: Buffer,
): Promise<{ ok: boolean; tip?: string }> {
    const idempotencyKey = buildIdempotencyKey(externalOrderId);
    let lastTip = '支付二维码提交失败，请稍后重试';

    for (let attempt = 0; attempt <= UPLOAD_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
            await sleep(UPLOAD_RETRY_DELAYS_MS[attempt - 1]!);
            logger.info('菲律宾通道上传重试：第 %s 次，订单=%s', attempt, externalOrderId);
        }
        try {
            const { httpStatus, body } = await uploadOnce(key, externalOrderId, idempotencyKey, pngBytes);
            const errorCode = String(body.error_code || '').trim();
            const requestId = String(body.request_id || '').trim();
            const rejection = itemRejectionCode(body);

            // 文档要求：即使 HTTP 202 / ok=true，也必须看 items[].result
            if (rejection) {
                lastTip = friendlyUploadTip(rejection, httpStatus);
                logger.warn(
                    '菲律宾通道上传被拒：订单=%s code=%s request_id=%s',
                    externalOrderId,
                    rejection,
                    requestId || '?',
                );
                // 已存在同单：视为可继续查询
                if (rejection === 'duplicate_external_order_id') {
                    return { ok: true, tip: lastTip };
                }
                return { ok: false, tip: lastTip };
            }

            if ((httpStatus === 200 || httpStatus === 202) && (itemAccepted(body) || body.ok === true)) {
                const replay = Boolean(body.data && (body.data as { idempotent_replay?: boolean }).idempotent_replay);
                logger.info(
                    '菲律宾通道上传成功：订单=%s http=%s replay=%s request_id=%s',
                    externalOrderId,
                    httpStatus,
                    replay,
                    requestId || '?',
                );
                return { ok: true };
            }

            lastTip = friendlyUploadTip(errorCode, httpStatus);
            const retryable =
                body.retryable === true || httpStatus === 429 || httpStatus >= 500;
            logger.warn(
                '菲律宾通道上传失败：订单=%s http=%s code=%s retryable=%s request_id=%s',
                externalOrderId,
                httpStatus,
                errorCode || '?',
                retryable,
                requestId || '?',
            );
            if (!retryable || attempt >= UPLOAD_RETRY_DELAYS_MS.length) {
                return { ok: false, tip: lastTip };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastTip = '支付通道暂时不可用，请稍后重试';
            logger.warn('菲律宾通道上传异常：订单=%s %s', externalOrderId, message);
            if (attempt >= UPLOAD_RETRY_DELAYS_MS.length) {
                return { ok: false, tip: lastTip };
            }
        }
    }
    return { ok: false, tip: lastTip };
}

async function fetchOrderState(
    key: string,
    externalOrderId: string,
): Promise<{ state: string; tip?: string; missing?: boolean }> {
    const url = `${ORDER_URL}/${encodeURIComponent(externalOrderId)}`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(30_000),
        });
        const body = await parseEnvelope(response);
        if (response.status === 404) {
            return { state: '', missing: true, tip: '支付订单查询失败' };
        }
        if (!response.ok || body.ok === false) {
            const tip = friendlyUploadTip(String(body.error_code || ''), response.status);
            return { state: '', tip };
        }
        const state = String(body.data?.state || '').trim().toLowerCase();
        return { state };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('菲律宾通道查询异常：订单=%s %s', externalOrderId, message);
        return { state: '', tip: '支付通道暂时不可用，请稍后重试' };
    }
}

/** 轮询到业务终态；进度文案只含业务含义 */
async function pollOrderUntilTerminal(
    key: string,
    externalOrderId: string,
    onProgress: ProgressFn,
): Promise<{ state: string; tip: string }> {
    const started = Date.now();
    let lastState = '';
    let lastTip = '支付二维码已提交，等待处理…';
    await onProgress(lastTip);

    while (Date.now() - started < POLL_MAX_MS) {
        const elapsed = Date.now() - started;
        const result = await fetchOrderState(key, externalOrderId);
        if (result.missing) {
            // 刚上传可能短暂查不到，继续等
            logger.info('菲律宾通道订单暂未可查：%s', externalOrderId);
        } else if (result.state) {
            if (result.state !== lastState) {
                lastState = result.state;
                lastTip = friendlyStateTip(result.state);
                logger.info('菲律宾通道订单状态：%s → %s', externalOrderId, result.state);
                await onProgress(lastTip);
            }
            if (TERMINAL_STATES.has(result.state)) {
                return { state: result.state, tip: lastTip };
            }
        } else if (result.tip && result.tip !== lastTip) {
            // 查询短暂失败不立刻终止，仅刷新提示（避免暴露技术细节）
            lastTip = '支付订单处理中，请稍候…';
        }

        const delay = elapsed < POLL_FAST_UNTIL_MS ? POLL_FAST_MS : POLL_SLOW_MS;
        await sleep(delay);
    }

    const tip = lastState ? friendlyStateTip(lastState) : '支付处理超时，请稍后在对方侧确认';
    logger.warn('菲律宾通道轮询超时：订单=%s lastState=%s', externalOrderId, lastState || '?');
    await onProgress(tip).catch(() => undefined);
    return { state: lastState, tip };
}

/**
 * 提链截屏后：把二维码提交到 GC 菲律宾通道并轮询终态。
 * 未配置密钥时直接跳过；失败只回友好文案，不抛出。
 */
export async function submitPaymentQrToGcPh(
    qrDataUrl: string,
    onProgress: ProgressFn = async () => undefined,
): Promise<GcPhSubmitResult> {
    const key = apiKey();
    if (!key) {
        logger.info('未配置 GC_PH_API_KEY，跳过菲律宾通道提图');
        return { submitted: false };
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::add-mask::${key}`);
    }

    const externalOrderId = buildExternalOrderId();
    try {
        await onProgress('正在提交支付二维码…');
        const pngBytes = dataUrlToPngBytes(qrDataUrl);
        logger.info(
            '开始提交菲律宾通道二维码：订单=%s size=%s',
            externalOrderId,
            pngBytes.length,
        );
        const uploaded = await uploadQrImage(key, externalOrderId, pngBytes);
        if (!uploaded.ok) {
            const tip = uploaded.tip || '支付二维码提交失败，请稍后重试';
            await onProgress(tip).catch(() => undefined);
            return { submitted: false, tip };
        }

        const polled = await pollOrderUntilTerminal(key, externalOrderId, onProgress);
        return {
            submitted: true,
            state: polled.state || undefined,
            tip: polled.tip,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('菲律宾通道提图失败（不影响主流程）：%s', message);
        const tip = /过大|格式|为空/.test(message)
            ? '支付二维码图片不符合要求，未能提交'
            : '支付二维码提交失败，请稍后重试';
        await onProgress(tip).catch(() => undefined);
        return { submitted: false, tip };
    }
}
