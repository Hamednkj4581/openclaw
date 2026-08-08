import type { Env, TaskState } from './types';
import { TASK_TTL_SECONDS } from './types';

export async function readTask(env: Env, taskId: string): Promise<TaskState | null> {
  const raw = await env.TASKS.get(`task:${taskId}`);
  if (!raw) return null;
  return JSON.parse(raw) as TaskState;
}

export async function writeTask(env: Env, taskId: string, state: TaskState): Promise<void> {
  state.updatedAt = Date.now();
  await env.TASKS.put(`task:${taskId}`, JSON.stringify(state), {
    expirationTtl: TASK_TTL_SECONDS,
  });
}

export function publicStatus(state: TaskState) {
  const doneCount = state.accounts.filter((a) => a.ok !== null).length;
  return {
    ok: true,
    phase: state.phase,
    message: state.message,
    total: state.total,
    doneCount,
    accounts: state.accounts.map((a) => ({
      index: a.index,
      email: a.email,
      ok: a.ok,
      accessToken: a.accessToken || undefined,
      error: a.error || undefined,
      hint: a.hint || undefined,
      paymentError: a.paymentError || undefined,
      paymentLink: a.paymentLink || undefined,
      paymentQr: a.paymentQr || undefined,
      paymentQrUrl: a.paymentQrUrl || undefined,
      holdUntil: a.holdUntil || undefined,
    })),
    done: state.phase === 'done' || state.phase === 'failed',
    success: state.phase === 'done',
  };
}
