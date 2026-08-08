import type { AccountResult, Env, TaskState } from './types';
import { TASK_TTL_SECONDS } from './types';

function taskKey(taskId: string): string {
  return `task:${taskId}`;
}

function accountKey(taskId: string, index: number): string {
  return `task:${taskId}:a:${index}`;
}

/** 任务元数据不内嵌账号详情，避免并行 progress/account_done 互相覆盖 */
function metaOnly(state: TaskState): TaskState {
  return {
    ...state,
    accounts: [],
  };
}

async function readAccount(
  env: Env,
  taskId: string,
  index: number,
): Promise<AccountResult | null> {
  const raw = await env.TASKS.get(accountKey(taskId, index));
  if (!raw) return null;
  return JSON.parse(raw) as AccountResult;
}

/** 旧任务把账号写在总键里：仅当账号键不存在时迁入，绝不覆盖已有准确进度 */
async function migrateLegacyAccounts(
  env: Env,
  taskId: string,
  legacy: AccountResult[] | undefined,
): Promise<void> {
  if (!legacy?.length) return;
  await Promise.all(
    legacy.map(async (row) => {
      const existing = await readAccount(env, taskId, row.index);
      if (!existing) await writeAccount(env, taskId, row);
    }),
  );
}

function placeholderAccount(index: number): AccountResult {
  return {
    index,
    email: `账号 ${index + 1}`,
    ok: null,
    hint: '排队中…',
  };
}

/** 按 total / 旧内嵌账号加载；不扫 KV list（Pages 上 list 会打崩 Worker → 回调 HTTP 500） */
async function loadAccounts(
  env: Env,
  taskId: string,
  legacy: AccountResult[] | undefined,
  total: number,
): Promise<AccountResult[]> {
  const legacyByIndex = new Map<number, AccountResult>();
  for (const row of legacy || []) {
    legacyByIndex.set(row.index, row);
  }

  const maxIndex = Math.max(total - 1, ...legacyByIndex.keys(), -1);
  if (maxIndex < 0) return [];

  const indexes = Array.from({ length: maxIndex + 1 }, (_, i) => i);
  const rows = await Promise.all(
    indexes.map(async (index) => {
      const fromKey = await readAccount(env, taskId, index);
      if (fromKey) return fromKey;
      const legacyRow = legacyByIndex.get(index);
      if (legacyRow) return legacyRow;
      return placeholderAccount(index);
    }),
  );

  return rows;
}

/** 根据账号序号抬高 total，避免 started 迟到/失败后 total 锁死在较小值 */
export function bumpTaskTotal(state: TaskState, index: number): void {
  state.total = Math.max(state.total || 0, index + 1);
}

export async function readTask(env: Env, taskId: string): Promise<TaskState | null> {
  const raw = await env.TASKS.get(taskKey(taskId));
  if (!raw) return null;
  const state = JSON.parse(raw) as TaskState;
  state.accounts = await loadAccounts(env, taskId, state.accounts, state.total || 0);
  if (state.accounts.length > (state.total || 0)) {
    state.total = state.accounts.length;
  }
  return state;
}

/**
 * 只写任务级字段。若总键里还有旧版内嵌账号，先按「键不存在才写入」迁到账号键，
 * 再清空内嵌，避免后续只读账号键时丢历史。
 */
export async function writeTaskMeta(env: Env, taskId: string, state: TaskState): Promise<void> {
  const raw = await env.TASKS.get(taskKey(taskId));
  if (raw) {
    const prev = JSON.parse(raw) as TaskState;
    await migrateLegacyAccounts(env, taskId, prev.accounts);
  }
  state.updatedAt = Date.now();
  await env.TASKS.put(taskKey(taskId), JSON.stringify(metaOnly(state)), {
    expirationTtl: TASK_TTL_SECONDS,
  });
}

export async function writeAccount(
  env: Env,
  taskId: string,
  account: AccountResult,
): Promise<void> {
  await env.TASKS.put(accountKey(taskId, account.index), JSON.stringify(account), {
    expirationTtl: TASK_TTL_SECONDS,
  });
}

/** 低频路径：先写齐账号键，再写元数据（避免元数据清空内嵌后账号尚未落键） */
export async function writeTask(env: Env, taskId: string, state: TaskState): Promise<void> {
  if (state.accounts.length > 0) {
    await Promise.all(state.accounts.map((account) => writeAccount(env, taskId, account)));
  }
  await writeTaskMeta(env, taskId, state);
}

/** 读取或创建单个账号槽位（只碰该账号键） */
export async function ensureAccount(
  env: Env,
  taskId: string,
  index: number,
  email: string,
): Promise<AccountResult> {
  const existing = await readAccount(env, taskId, index);
  if (existing) {
    if (email) existing.email = email;
    return existing;
  }
  return {
    index,
    email: email || `账号 ${index + 1}`,
    ok: null,
  };
}

export function publicStatus(state: TaskState) {
  const doneCount = state.accounts.filter((a) => a.ok !== null).length;
  return {
    ok: true,
    phase: state.phase,
    message: state.message,
    runName: state.runName || undefined,
    total: state.total,
    doneCount,
    logs: state.logs || [],
    accounts: state.accounts.map((a) => ({
      index: a.index,
      email: a.email,
      ok: a.ok,
      accessToken: a.accessToken || undefined,
      cookiesJson: a.cookiesJson || undefined,
      password: a.password || undefined,
      otpSecret: a.otpSecret || undefined,
      error: a.error || undefined,
      hint: a.hint || undefined,
      paymentError: a.paymentError || undefined,
      paymentLink: a.paymentLink || undefined,
      paymentQr: a.paymentQr || undefined,
      holdUntil: a.holdUntil || undefined,
      logs: a.logs || [],
    })),
    done: state.phase === 'done' || state.phase === 'failed' || state.phase === 'cancelled',
    success: state.phase === 'done',
  };
}
