import axios from 'axios';
import Utility from './Utility.js';
import logger from './logger.js';
import { ChatGptVerification, WaitForVerificationOptions } from './outlookMail.js';

export interface ICloudCredentials {
    email: string;
    apiKey: string;
}

interface ICloudCodeResponse {
    ok?: boolean;
    code?: unknown;
    mail?: unknown;
    lookup_status?: unknown;
    lookup?: {
        status?: unknown;
        alias_status?: unknown;
        alias_active?: unknown;
    };
    fetched_at?: unknown;
    error?: unknown;
    message?: unknown;
}

const API_URL = 'https://icloud.xbovo.online/api/v1/code';
const DEFAULT_VERIFICATION_TIMEOUT_MS = 30_000;

function maskEmail(email: string): string {
    const [name, domain = ''] = email.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
}

function safeMessage(value: unknown, credentials: ICloudCredentials): string {
    return String(value ?? 'unknown')
        .replaceAll(credentials.apiKey, '[REDACTED]')
        .replaceAll(credentials.email, maskEmail(credentials.email))
        .slice(0, 500);
}

function icloudError(credentials: ICloudCredentials, stage: string, category: string, error: any, retryable: boolean, action: string): Error {
    const details = {
        email: maskEmail(credentials.email),
        stage,
        category,
        status: error?.response?.status ?? error?.code ?? null,
        message: safeMessage(error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message ?? error, credentials),
        retryable,
        action
    };
    return new Error(`ICLOUD_MAIL ${JSON.stringify(details)}`);
}

async function fetchLatestCode(credentials: ICloudCredentials): Promise<ICloudCodeResponse> {
    try {
        const { data } = await axios.get<ICloudCodeResponse>(API_URL, {
            params: { email: credentials.email, key: credentials.apiKey },
            timeout: 15_000
        });
        if (!data || typeof data !== 'object')
            throw new Error('API 返回内容不是 JSON 对象');
        return data;
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('ICLOUD_MAIL '))
            throw error;
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const unauthorized = status === 401 || status === 403;
            throw icloudError(
                credentials,
                'api_request',
                unauthorized ? 'invalid_api_key' : status ? 'api_error' : 'network_error',
                error,
                !unauthorized && (!status || status >= 500),
                unauthorized ? '确认 iCloud API Key 有效且有权访问该邮箱' : '检查 iCloud 验证码 API 和网络后重试'
            );
        }
        throw icloudError(credentials, 'api_response', 'invalid_response', error, false, '检查 iCloud 验证码 API 响应格式');
    }
}

function findMailTime(value: unknown): Date | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    for (const name of ['mail_time', 'received_at', 'receivedAt', 'date', 'time', 'created_at', 'createdAt']) {
        const raw = record[name];
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return undefined;
}

export async function preflightICloud(credentials: ICloudCredentials): Promise<void> {
    if (!/^\S+@\S+\.\S+$/.test(credentials.email) || !credentials.apiKey.trim())
        throw icloudError(credentials, 'input_validation', 'invalid_input', new Error('邮箱或 API Key 格式无效'), false, '修正 iCloud 账号输入格式');

    const data = await fetchLatestCode(credentials);
    if (data.ok !== true)
        throw icloudError(credentials, 'api_validation', 'api_rejected', new Error(String(data.message ?? data.error ?? data.lookup_status ?? 'ok is not true')), false, '确认邮箱和 iCloud API Key 有效');
    if (data.lookup?.alias_active === false)
        throw icloudError(credentials, 'alias_validation', 'alias_inactive', new Error(String(data.lookup.alias_status ?? 'alias is inactive')), false, '启用该 iCloud 邮箱别名后重试');

    logger.info('iCloud 验证码 API 预检成功：%s，状态：%s', maskEmail(credentials.email), String(data.lookup_status ?? data.lookup?.status ?? 'ok'));
}

export async function waitForICloudVerification(
    credentials: ICloudCredentials,
    options: WaitForVerificationOptions
): Promise<ChatGptVerification> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const data = await fetchLatestCode(credentials);
        if (data.ok !== true)
            throw icloudError(credentials, 'code_lookup', 'api_rejected', new Error(String(data.message ?? data.error ?? data.lookup_status ?? 'ok is not true')), false, '确认邮箱和 iCloud API Key 有效');

        const code = typeof data.code === 'string' ? data.code.trim() : String(data.code ?? '').trim();
        const mailTime = findMailTime(data.mail);
        const isCurrentMail = !mailTime || mailTime.getTime() >= options.receivedAfter.getTime();
        if (/^\d{6}$/.test(code) && data.mail && isCurrentMail)
            return { type: 'code', value: code };

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        logger.info('iCloud API 尚未返回新的 ChatGPT 验证码，等待下一次轮询（剩余约 %d 秒）', Math.ceil(remainingMs / 1000));
        await Utility.waitForSeconds(Math.min(pollIntervalMs, remainingMs) / 1000);
    }

    throw new Error(`等待 iCloud ChatGPT 验证码超时（${Math.round(timeoutMs / 1000)} 秒）`);
}