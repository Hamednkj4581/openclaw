export type TaskMode = 'register' | 'login';
export type TaskPhase = 'submitted' | 'processing' | 'done' | 'failed';

export interface AccountResult {
  index: number;
  email: string;
  /** null 表示尚未结束 */
  ok: boolean | null;
  accessToken?: string;
  error?: string;
  /** 登录保持结束时间（epoch ms），有值时前端显示倒计时 */
  holdUntil?: number;
}

export interface TaskState {
  mode: TaskMode;
  phase: TaskPhase;
  message: string;
  total: number;
  accounts: AccountResult[];
  /** oai9 提链得到的最终支付链接列表 */
  paymentLinks?: string[];
  paymentMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Env {
  TASKS: KVNamespace;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_REF: string;
  WEBHOOK_SECRET: string;
}

export const TASK_TTL_SECONDS = 60 * 60 * 24;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function friendlyError(status = 400, message = '请求无效'): Response {
  return json({ ok: false, message }, status);
}
