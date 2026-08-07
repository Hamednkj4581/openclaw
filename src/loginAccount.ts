/** 解析 email----password----2fa（四个或更多连续连字符分隔；允许尾部多余字段） */
export type LoginAccount = { email: string; password: string; otpSecret: string };

export function parseLoginAccount(raw: string): LoginAccount {
    const line = raw.trim();
    if (!line) throw new Error('登录账号为空');
    const fields = line.split(/-{4,}/).map(part => part.trim()).filter(Boolean);
    if (fields.length < 3)
        throw new Error('登录账号格式应为 email----password----2fa');
    const [email, password, otpSecret] = fields;
    if (!email.includes('@')) throw new Error('登录邮箱格式无效');
    if (!password) throw new Error('登录密码为空');
    if (!/^[A-Z2-7=]+$/i.test(otpSecret.replace(/\s+/g, '')))
        throw new Error('2FA 密钥应为 Base32（TOTP secret）');
    return { email, password, otpSecret: otpSecret.replace(/\s+/g, '') };
}
