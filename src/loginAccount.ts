/** 解析 email----password----2fa（四个或更多连续连字符分隔） */
export type LoginAccount = { email: string; password: string; otpSecret: string };

const BASE32_RE = /^[A-Z2-7=]+$/i;

export function parseLoginAccount(raw: string): LoginAccount {
    const line = raw.trim();
    if (!line) throw new Error('登录账号为空');
    const fields = line.split(/-{4,}/).map(part => part.trim()).filter(Boolean);
    if (fields.length < 3)
        throw new Error('登录账号格式应为 email----password----2fa');
    const [email, password, third] = fields;
    if (!email.includes('@')) throw new Error('登录邮箱格式无效');
    if (!password) throw new Error('登录密码为空');
    // 第三段做 2FA（Base32）识别；识别成功则忽略第四段及以后（取件链接、accessToken 等）
    const otpSecret = third.replace(/\s+/g, '');
    if (!BASE32_RE.test(otpSecret))
        throw new Error('2FA 密钥应为 Base32（TOTP secret）');
    return { email, password, otpSecret };
}
