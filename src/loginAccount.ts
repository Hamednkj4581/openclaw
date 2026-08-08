/** 登录/绑定手机：与注册取件格式一致，额外支持 email----password----2fa */
export type LoginAccount = {
    email: string;
    password: string;
    otpSecret?: string;
};

const BASE32_RE = /^[A-Z2-7=]+$/i;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function isBase32(value: string): boolean {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < 10) return false;
    return BASE32_RE.test(compact);
}

function splitFields(raw: string): string[] {
    return raw.trim().split(/-{4,}/).map(part => part.trim()).filter(Boolean);
}

/** 与 account_input.parse_accounts 单条记录规则一致（不含 3 字段 2FA） */
function parseRegisterStyleFields(fields: string[]): Pick<LoginAccount, 'email' | 'password'> {
    if (!fields.length) throw new Error('登录账号为空');
    const email = fields[0];
    if (!EMAIL_RE.test(email)) throw new Error('登录邮箱格式无效');

    if (fields.length === 1) return { email, password: '' };

    if (fields.length === 2) {
        if (!fields[1]) throw new Error('取件字段为空');
        return { email, password: '' };
    }

    if (fields.length === 4) {
        if (!fields[1] || !fields[2] || !fields[3]) throw new Error('Outlook 四字段不完整');
        return { email, password: '' };
    }

    throw new Error('登录账号格式无效');
}

export function parseLoginAccount(raw: string): LoginAccount {
    const fields = splitFields(raw);
    if (!fields.length) throw new Error('登录账号为空');

    if (fields.length >= 3 && isBase32(fields[2])) {
        const email = fields[0];
        const password = fields[1];
        if (!EMAIL_RE.test(email)) throw new Error('登录邮箱格式无效');
        if (!password) throw new Error('登录密码为空');
        return { email, password, otpSecret: fields[2].replace(/\s+/g, '') };
    }

    return parseRegisterStyleFields(fields);
}
