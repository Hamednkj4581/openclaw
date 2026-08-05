import { ICloudCredentials, preflightICloud, waitForICloudVerification } from './icloudMail.js';
import { ChatGptVerification, OutlookCredentials, preflightOutlook, WaitForVerificationOptions, waitForChatGptVerification } from './outlookMail.js';

export type MailCredentials =
    | ({ provider: 'outlook' } & OutlookCredentials)
    | ({ provider: 'icloud' } & ICloudCredentials);

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`缺少环境变量 ${name}`);
    return value;
}

export function credentialsFromEnv(): MailCredentials {
    const email = requiredEnv('EMAIL');
    const apiKey = process.env.ICLOUD_API_KEY?.trim();
    if (apiKey)
        return { provider: 'icloud', email, apiKey };
    return {
        provider: 'outlook',
        email,
        clientId: requiredEnv('CLIENT_ID'),
        refreshToken: requiredEnv('REFRESH_TOKEN')
    };
}

export async function preflightMail(credentials: MailCredentials): Promise<void> {
    if (credentials.provider === 'icloud') return preflightICloud(credentials);
    return preflightOutlook(credentials);
}

export async function waitForMailVerification(credentials: MailCredentials, options: WaitForVerificationOptions): Promise<ChatGptVerification> {
    if (credentials.provider === 'icloud') return waitForICloudVerification(credentials, options);
    return waitForChatGptVerification(credentials, options);
}