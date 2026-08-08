export type TaskMode = 'register' | 'login';

export interface TriggerPayload {
  mode: TaskMode;
  accounts: string;
  forwarding_emails?: string;
  enable_mfa?: boolean;
  enable_711_proxy?: boolean;
  payment_link_type?: string;
  payment_card?: string;
  hold_minutes?: number;
}

export interface AccountStatus {
  index: number;
  email: string;
  ok: boolean | null;
  accessToken?: string;
  error?: string;
  hint?: string;
  holdUntil?: number;
}

export interface TaskStatus {
  ok: boolean;
  phase: 'submitted' | 'processing' | 'done' | 'failed';
  message: string;
  total: number;
  doneCount: number;
  accounts: AccountStatus[];
  paymentLinks?: string[];
  paymentMessage?: string;
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

export async function triggerTask(payload: TriggerPayload): Promise<{ taskId: string; message: string }> {
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
