/** 登录/绑定手机账号解析（与注册取件格式一致，额外支持 password + 2FA） */
export type LoginAccount = {
    email: string;
    /** ChatGPT 登录密码；取件两字段/单邮箱格式可无密码 */
    password: string;
    /** TOTP 密钥；无则登录遇到 MFA 挑战时会失败 */
    otpSecret?: string;
};

const BASE32_RE = /^[A-Z2-7=]+$/i;
const URL_RE = /^https?:\/\//i;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function isBase32(value: string): boolean {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < 10) return false;
    return BASE32_RE.test(compact);
}

function splitFields(raw: string): string[] {
    return raw.trim().split(/-{4,}/).map(part => part.trim()).filter(Boolean);
}

/** 从多字段记录中识别 2FA（第三段起为 password + 后缀） */
function parsePasswordLoginFields(fields: string[]): LoginAccount {
    const email = fields[0];
    const password = fields[1];
    if (!EMAIL_RE.test(email)) throw new Error('登录邮箱格式无效');
    if (!password) throw new Error('登录密码为空');

    if (fields.length >= 5) {
        const third = fields[2].replace(/\s+/g, '');
        if (isBase32(third))
            return { email, password, otpSecret: third };
        const otpRaw = fields[4].replace(/\s+/g, '');
        if (!isBase32(otpRaw)) throw new Error('Outlook 取件五字段时，第五段应为 Base32 2FA 密钥');
        return { email, password, otpSecret: otpRaw };
    }

    if (fields.length === 4) {
        const third = fields[2];
        const fourth = fields[3];
        if (isBase32(third))
            return { email, password, otpSecret: third.replace(/\s+/g, '') };
        if (isBase32(fourth))
            return { email, password, otpSecret: fourth.replace(/\s+/g, '') };
        return { email, password };
    }

    const third = fields[2];
    if (isBase32(third))
        return { email, password, otpSecret: third.replace(/\s+/g, '') };
    return { email, password };
}

export function parseLoginAccount(raw: string): LoginAccount {
    const fields = splitFields(raw);
    if (!fields.length) throw new Error('登录账号为空');

    if (fields.length === 1) {
        if (!EMAIL_RE.test(fields[0])) throw new Error('登录邮箱格式无效');
        return { email: fields[0], password: '' };
    }

    // 与注册相同：email----取件链接或 iCloud Key
    if (fields.length === 2) {
        if (!EMAIL_RE.test(fields[0])) throw new Error('登录邮箱格式无效');
        if (!fields[1]) throw new Error('取件字段为空');
        return { email: fields[0], password: '' };
    }

    // 与注册相同：Outlook 四字段（第二段为邮箱密码，非 2FA）
    if (fields.length === 4) {
        const third = fields[2];
        const fourth = fields[3];
        if (!isBase32(third) && !isBase32(fourth)) {
            if (!EMAIL_RE.test(fields[0])) throw new Error('登录邮箱格式无效');
            if (!fields[1] || !third || !fourth) throw new Error('Outlook 取件四字段不完整');
            return { email: fields[0], password: fields[1] };
        }
    }

    if (fields.length < 3)
        throw new Error('登录账号格式无效');

    return parsePasswordLoginFields(fields);
}

/** 是否配置了行内取件（与注册相同：两字段 / 四字段 Outlook） */
export function loginAccountHasInlineMailPickup(raw: string): boolean {
    const fields = splitFields(raw);
    if (fields.length === 2) return Boolean(fields[1]);
    if (fields.length === 4) {
        const third = fields[2];
        const fourth = fields[3];
        if (isBase32(third) || isBase32(fourth)) return true;
        return Boolean(third && fourth);
    }
    if (fields.length < 3) return false;
    if (fields.length >= 5) return true;
    if (fields.length === 3) return !isBase32(fields[2]);
    return true;
}

export function isWebMailPickupValue(value: string): boolean {
    return URL_RE.test(value.trim());
}
