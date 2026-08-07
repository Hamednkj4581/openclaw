import type { AccountResult, Env, TaskState } from '../_shared/types';
import { friendlyError, json } from '../_shared/types';
import { readTask, writeTask } from '../_shared/tasks';

interface WebhookBody {
  taskId?: string;
  event?: 'started' | 'account_done' | 'finished';
  total?: number;
  account?: {
    index?: number;
    email?: string;
    ok?: boolean;
    accessToken?: string;
    error?: string;
  };
  ok?: boolean;
}

function ensureAccountSlot(state: TaskState, index: number, email: string): AccountResult {
  let row = state.accounts.find((a) => a.index === index);
  if (!row) {
    row = { index, email, ok: null };
    state.accounts.push(row);
    state.accounts.sort((a, b) => a.index - b.index);
  } else if (email) {
    row.email = email;
  }
  return row;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const secret = context.request.headers.get('X-Webhook-Secret') || '';
  if (!context.env.WEBHOOK_SECRET || secret !== context.env.WEBHOOK_SECRET) {
    return friendlyError(401, '未授权');
  }

  let body: WebhookBody;
  try {
    body = (await context.request.json()) as WebhookBody;
  } catch {
    return friendlyError(400, '请求格式无效');
  }

  const taskId = (body.taskId || '').trim();
  if (!taskId || !body.event) return friendlyError(400, '参数不完整');

  const state = await readTask(context.env, taskId);
  if (!state) return friendlyError(404, '任务不存在或已过期');

  if (body.event === 'started') {
    const total = Number(body.total) || 0;
    state.total = total;
    state.phase = 'processing';
    state.message = total > 0 ? `处理中（0/${total}）` : '处理中';
    if (total > 0 && state.accounts.length === 0) {
      state.accounts = Array.from({ length: total }, (_, index) => ({
        index,
        email: `账号 ${index + 1}`,
        ok: null,
      }));
    }
  } else if (body.event === 'account_done') {
    const index = Number(body.account?.index);
    if (!Number.isInteger(index) || index < 0) return friendlyError(400, '账号序号无效');
    const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
    const row = ensureAccountSlot(state, index, email);
    row.ok = Boolean(body.account?.ok);
    if (row.ok && body.account?.accessToken) {
      row.accessToken = body.account.accessToken;
      delete row.error;
    } else {
      delete row.accessToken;
      row.error = (body.account?.error || '处理失败').slice(0, 80);
    }
    if (!state.total) state.total = Math.max(state.accounts.length, index + 1);
    const doneCount = state.accounts.filter((a) => a.ok !== null).length;
    state.phase = 'processing';
    state.message = `处理中（${doneCount}/${state.total || '?'}）`;
  } else if (body.event === 'finished') {
    const allOk = state.accounts.length > 0 && state.accounts.every((a) => a.ok === true);
    const anyOk = state.accounts.some((a) => a.ok === true);
    if (allOk) {
      state.phase = 'done';
      state.message = '全部完成';
    } else if (anyOk) {
      state.phase = 'done';
      state.message = '部分完成';
    } else {
      state.phase = 'failed';
      state.message = '全部失败';
    }
  } else {
    return friendlyError(400, '未知事件');
  }

  await writeTask(context.env, taskId, state);
  return json({ ok: true });
};
