export type TaskMode = 'register' | 'login' | 'bind_phone';
export type TaskPhase = 'submitted' | 'processing' | 'done' | 'failed' | 'cancelled';

/** 账号进度时间线条目 */
export interface ProgressLogEntry {
  /** epoch ms */
  at: number;
  message: string;
}

export interface AccountResult {
  index: number;
  email: string;
  /** null 表示尚未结束 */
  ok: boolean | null;
  accessToken?: string;
  /** Cookie-Editor 可导入的 JSON 字符串 */
  cookiesJson?: string;
  /** 注册生成的 ChatGPT 密码 */
  password?: string;
  /** 注册开启的 2FA 密钥 */
  otpSecret?: string;
  error?: string;
  /** 进行中提示 */
  hint?: string;
  /** 登录/注册成功但提链失败时的原因（持久展示） */
  paymentError?: string;
  /** 单账号支付链接（URL） */
  paymentLink?: string;
  /** 提链页区域截屏（提示文案 + 二维码，data:image/...;base64,...） */
  paymentQr?: string;
  /** @deprecated 已改为只回传图片，读取时清理旧字段 */
  paymentQrUrl?: string;
  /** 登录保持结束时间（epoch ms），有值时前端显示倒计时 */
  holdUntil?: number;
  /** 绑定的手机号 */
  phoneNumber?: string;
  /** 手机号绑定失败原因 */
  phoneBindError?: string;
  /** 按时间排列的进度详情（点击展开） */
  logs?: ProgressLogEntry[];
}

export interface TaskState {
  mode: TaskMode;
  phase: TaskPhase;
  message: string;
  total: number;
  accounts: AccountResult[];
  /** 与 GitHub Actions run-name 一致（如 web-login-20260808-145540） */
  runName?: string;
  /** @deprecated 提链已改为账号级 paymentLink */
  paymentLinks?: string[];
  paymentMessage?: string;
  /** 任务级时间线（无账号序号的全局事件） */
  logs?: ProgressLogEntry[];
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
const MAX_PROGRESS_LOGS = 100;
const LOG_MESSAGE_MAX = 160;

/** 追加一条进度日志；同秒同文案去重，超出上限丢弃最早条目 */
export function appendProgressLog(
  target: { logs?: ProgressLogEntry[] },
  message: string,
  at = Date.now(),
): void {
  const text = message.trim().slice(0, LOG_MESSAGE_MAX);
  if (!text) return;
  const logs = target.logs ? [...target.logs] : [];
  const last = logs[logs.length - 1];
  if (last && last.message === text && Math.abs(at - last.at) < 1000) return;
  logs.push({ at, message: text });
  if (logs.length > MAX_PROGRESS_LOGS) {
    logs.splice(0, logs.length - MAX_PROGRESS_LOGS);
  }
  target.logs = logs;
}

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
