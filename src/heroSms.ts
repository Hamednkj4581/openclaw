import logger from './logger.js';

const HERO_SMS_BASE = 'https://hero-sms.com/stubs/handler_api.php';
const DEFAULT_SMS_TIMEOUT_MS = 120_000;
const DEFAULT_SMS_POLL_MS = 5_000;

export type HeroSmsCountry = {
    id: number;
    name: string;
};

export type HeroSmsService = {
    code: string;
    name: string;
};

export type HeroSmsNumber = {
    activationId: number;
    phoneNumber: string;
};

export type HeroSmsStatus =
    | { status: 'STATUS_WAIT_CODE' }
    | { status: 'STATUS_WAIT_RESEND' }
    | { status: 'STATUS_CANCEL' }
    | { status: 'STATUS_OK'; code: string }
    | { status: 'STATUS_WAIT_RETRY'; code: string };

export class HeroSmsError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
        this.name = 'HeroSmsError';
    }
}

function apiKey(): string {
    return (process.env.HERO_SMS_API_KEY || '').trim();
}

export function heroSmsService(): string {
    return (process.env.HERO_SMS_SERVICE || '').trim();
}

export function heroSmsCountry(): number | null {
    const raw = (process.env.HERO_SMS_COUNTRY || '').trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
}

export function isHeroSmsConfigured(): boolean {
    return Boolean(apiKey() && heroSmsService() && heroSmsCountry() !== null);
}

async function requestText(
    key: string,
    action: string,
    params: Record<string, string | number> = {},
): Promise<string> {
    const url = new URL(HERO_SMS_BASE);
    url.searchParams.set('api_key', key);
    url.searchParams.set('action', action);
    for (const [name, value] of Object.entries(params)) {
        url.searchParams.set(name, String(value));
    }
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
    const text = (await response.text()).trim();
    if (!response.ok) throw new HeroSmsError(`Hero SMS HTTP ${response.status}`);
    return text;
}

function checkTextErrors(text: string): void {
    if (text.startsWith('BANNED:')) throw new HeroSmsError('Hero SMS 账号已被封禁', 'BANNED');
    if (text.startsWith('WRONG_MAX_PRICE:')) throw new HeroSmsError('Hero SMS 价格上限过低', 'WRONG_MAX_PRICE');
    const codes = [
        'BAD_KEY', 'NO_KEY', 'NO_NUMBERS', 'NO_ACTIVATION', 'BAD_SERVICE',
        'BAD_STATUS', 'EARLY_CANCEL_DENIED', 'NO_BALANCE', 'ERROR_SQL',
    ] as const;
    for (const code of codes) {
        if (text === code || text.startsWith(`${code}:`)) {
            throw new HeroSmsError(`Hero SMS 返回 ${code}`, code);
        }
    }
}

function parseStatus(text: string): HeroSmsStatus {
    checkTextErrors(text);
    if (text.startsWith('STATUS_OK:')) {
        return { status: 'STATUS_OK', code: text.slice('STATUS_OK:'.length).trim() };
    }
    if (text.startsWith('STATUS_WAIT_RETRY:')) {
        return { status: 'STATUS_WAIT_RETRY', code: text.slice('STATUS_WAIT_RETRY:'.length).trim() };
    }
    if (text === 'STATUS_WAIT_CODE') return { status: 'STATUS_WAIT_CODE' };
    if (text === 'STATUS_WAIT_RESEND') return { status: 'STATUS_WAIT_RESEND' };
    if (text === 'STATUS_CANCEL') return { status: 'STATUS_CANCEL' };
    throw new HeroSmsError(`无法解析 Hero SMS 状态：${text.slice(0, 80)}`);
}

function parseNumber(text: string): HeroSmsNumber {
    checkTextErrors(text);
    const match = /^ACCESS_NUMBER:(\d+):(.+)$/.exec(text);
    if (!match) throw new HeroSmsError(`无法解析 Hero SMS 号码：${text.slice(0, 80)}`);
    return {
        activationId: Number(match[1]),
        phoneNumber: match[2].trim(),
    };
}

function parseCountriesPayload(payload: unknown): HeroSmsCountry[] {
    if (!payload || typeof payload !== 'object') return [];
    const rows: HeroSmsCountry[] = [];
    for (const value of Object.values(payload as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        const id = Number(row.id);
        const name = String(row.eng || row.rus || row.name || '').trim();
        if (!Number.isInteger(id) || id < 0 || !name) continue;
        rows.push({ id, name });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return rows;
}

function parseServicesPayload(payload: unknown): HeroSmsService[] {
    if (!payload || typeof payload !== 'object') return [];
    const root = payload as Record<string, unknown>;
    const list = Array.isArray(root.services)
        ? root.services
        : Array.isArray(payload)
            ? payload
            : [];
    const rows: HeroSmsService[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const code = String(row.code || row.service || '').trim();
        const name = String(row.name || row.title || code).trim();
        if (!code) continue;
        rows.push({ code, name });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return rows;
}

export async function fetchHeroSmsBalance(key: string): Promise<number> {
    const text = await requestText(key, 'getBalance');
    checkTextErrors(text);
    const match = /^ACCESS_BALANCE:(.+)$/.exec(text);
    if (!match) throw new HeroSmsError(`无法解析 Hero SMS 余额：${text.slice(0, 80)}`);
    const balance = Number(match[1]);
    if (!Number.isFinite(balance)) throw new HeroSmsError('Hero SMS 余额格式无效');
    return balance;
}

export async function fetchHeroSmsCountries(key: string): Promise<HeroSmsCountry[]> {
    const text = await requestText(key, 'getCountries');
    checkTextErrors(text);
    try {
        return parseCountriesPayload(JSON.parse(text));
    } catch {
        throw new HeroSmsError('Hero SMS 国家列表格式无效');
    }
}

export async function fetchHeroSmsServices(key: string, country?: number): Promise<HeroSmsService[]> {
    const params: Record<string, string | number> = { lang: 'en' };
    if (typeof country === 'number' && Number.isInteger(country)) params.country = country;
    const text = await requestText(key, 'getServicesList', params);
    checkTextErrors(text);
    try {
        return parseServicesPayload(JSON.parse(text));
    } catch {
        throw new HeroSmsError('Hero SMS 服务列表格式无效');
    }
}

export async function requestHeroSmsNumber(
    key: string,
    service: string,
    country: number,
): Promise<HeroSmsNumber> {
    const text = await requestText(key, 'getNumber', { service, country });
    return parseNumber(text);
}

export async function markHeroSmsReady(key: string, activationId: number): Promise<void> {
    const text = await requestText(key, 'setStatus', { id: activationId, status: 1 });
    checkTextErrors(text);
}

export async function completeHeroSmsActivation(key: string, activationId: number): Promise<void> {
    const text = await requestText(key, 'setStatus', { id: activationId, status: 6 });
    checkTextErrors(text);
}

export async function cancelHeroSmsActivation(key: string, activationId: number): Promise<void> {
    try {
        const text = await requestText(key, 'setStatus', { id: activationId, status: 8 });
        checkTextErrors(text);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Hero SMS 取消号码失败：%s', message);
    }
}

export async function fetchHeroSmsStatus(key: string, activationId: number): Promise<HeroSmsStatus> {
    const text = await requestText(key, 'getStatus', { id: activationId });
    return parseStatus(text);
}

/** 轮询直到收到验证码或超时 */
export async function waitHeroSmsCode(
    key: string,
    activationId: number,
    timeoutMs = DEFAULT_SMS_TIMEOUT_MS,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await fetchHeroSmsStatus(key, activationId);
        if (status.status === 'STATUS_OK' || status.status === 'STATUS_WAIT_RETRY') {
            const code = status.code.replace(/\D/g, '');
            if (code) return code;
        }
        if (status.status === 'STATUS_CANCEL') {
            throw new HeroSmsError('Hero SMS 号码已取消', 'STATUS_CANCEL');
        }
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_SMS_POLL_MS));
    }
    throw new HeroSmsError('等待短信验证码超时', 'TIMEOUT');
}

export function maskPhoneNumber(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 4) return digits;
    return `${digits.slice(0, 3)}****${digits.slice(-2)}`;
}
