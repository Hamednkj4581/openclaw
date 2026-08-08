/** 登录/绑定手机账号解析（在注册取件格式基础上额外支持 2FA） */
export type LoginAccount = {
    email: string;
    password: string;
    /** TOTP 密钥；无则登录遇到 MFA 挑战时会失败 */
    otpSecret?: string;
};

const BASE32_RE = /^[A-Z2-7=]+$/i;
const URL_RE = /^https?:\/\//i;

function isBase32(value: string): boolean {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < 10) return false;
    return BASE32_RE.test(compact);
}

function splitFields(raw: string): string[] {
    return raw.trim().split(/-{4,}/).map(part => part.trim()).filter(Boolean);
}

/** 从多字段记录中识别 2FA 与取件凭据位置 */
export function parseLoginAccount(raw: string): LoginAccount {
    const fields = splitFields(raw);
    if (fields.length < 3)
        throw new Error('登录账号格式至少为 email----password----2fa 或取件字段');

    const email = fields[0];
    const password = fields[1];
    if (!email.includes('@')) throw new Error('登录邮箱格式无效');
    if (!password) throw new Error('登录密码为空');

    // 5 段及以上：第三段为 2FA 时视为尾部可忽略；否则按 Outlook 四字段 + 末尾 2FA
    if (fields.length >= 5) {
        const third = fields[2].replace(/\s+/g, '');
        if (isBase32(third))
            return { email, password, otpSecret: third };
        const otpRaw = fields[4].replace(/\s+/g, '');
        if (!isBase32(otpRaw)) throw new Error('Outlook 取件五字段时，第五段应为 Base32 2FA 密钥');
        return { email, password, otpSecret: otpRaw };
    }

    // 4 字段：Outlook 取件，或 2FA + 尾部字段，或 取件 + 2FA
    if (fields.length === 4) {
        const third = fields[2];
        const fourth = fields[3];
        if (isBase32(third))
            return { email, password, otpSecret: third.replace(/\s+/g, '') };
        if (isBase32(fourth))
            return { email, password, otpSecret: fourth.replace(/\s+/g, '') };
        return { email, password };
    }

    // 3 字段：第三段为 2FA、网页取件链接或 iCloud Key
    const third = fields[2];
    if (isBase32(third))
        return { email, password, otpSecret: third.replace(/\s+/g, '') };
    return { email, password };
}

/** 是否配置了行内取件（iCloud / 网页 / Outlook 四字段） */
export function loginAccountHasInlineMailPickup(raw: string): boolean {
    const fields = splitFields(raw);
    if (fields.length < 3) return false;
    if (fields.length >= 5) return true;
    if (fields.length === 4) {
        const third = fields[2];
        const fourth = fields[3];
        if (isBase32(third)) return false;
        if (isBase32(fourth)) return true;
        return true;
    }
    return !isBase32(fields[2]);
}

export function isWebMailPickupValue(value: string): boolean {
    return URL_RE.test(value.trim());
}
