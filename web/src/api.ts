export type TaskMode = 'register' | 'login' | 'bind_phone';

export interface TriggerPayload {
  mode: TaskMode;
  accounts: string;
  forwarding_emails?: string;
  enable_mfa?: boolean;
  enable_proxy?: boolean;
  proxy_region?: string;
  proxy_links?: string;
  payment_link_type?: string;
  payment_card?: string;
  gc_ph_api_key?: string;
  hero_sms_api_key?: string;
  hero_sms_service?: string;
  hero_sms_country?: string;
  hold_minutes?: number;
}

export interface ProgressLogEntry {
  at: number;
  message: string;
}

export interface AccountStatus {
  index: number;
  email: string;
  ok: boolean | null;
  accessToken?: string;
  cookiesJson?: string;
  password?: string;
  otpSecret?: string;
  error?: string;
  hint?: string;
  paymentError?: string;
  paymentLink?: string;
  paymentQr?: string;
  holdUntil?: number;
  phoneNumber?: string;
  phoneBindError?: string;
  logs?: ProgressLogEntry[];
}

export interface TaskStatus {
  ok: boolean;
  phase: 'submitted' | 'processing' | 'done' | 'failed' | 'cancelled';
  message: string;
  /** 与 GitHub Actions run-name 一致 */
  runName?: string;
  total: number;
  doneCount: number;
  logs?: ProgressLogEntry[];
  accounts: AccountStatus[];
  done: boolean;
  success: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok) {
    throw new Error(data.message || '请求失败');
  }
  return data;
}

export async function triggerTask(
  payload: TriggerPayload,
): Promise<{ taskId: string; runName: string; message: string }> {
  const response = await fetch('/api/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson(response);
}

export async function fetchStatus(taskId: string): Promise<TaskStatus> {
  const response = await fetch(`/api/status?taskId=${encodeURIComponent(taskId)}`);
  return readJson(response);
}

export async function cancelTask(taskId: string): Promise<{ message: string; phase?: string }> {
  const response = await fetch('/api/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  return readJson(response);
}

export interface HeroSmsCountry {
  id: number;
  name: string;
}

export interface HeroSmsService {
  code: string;
  name: string;
}

export async function fetchHeroSmsMeta(
  apiKey: string,
  country?: number,
): Promise<{ countries: HeroSmsCountry[]; services: HeroSmsService[] }> {
  const response = await fetch('/api/hero-sms-meta', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      ...(typeof country === 'number' ? { country } : {}),
    }),
  });
  return readJson(response);
}
