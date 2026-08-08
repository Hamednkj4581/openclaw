import type { AccountResult, Env, TaskState } from '../_shared/types';
import { friendlyError, json } from '../_shared/types';
import { readTask, writeTask } from '../_shared/tasks';

interface WebhookBody {
  taskId?: string;
  event?: 'started' | 'progress' | 'account_done' | 'finished';
  message?: string;
  total?: number;
  account?: {
    index?: number;
    email?: string;
    ok?: boolean;
    accessToken?: string;
    error?: string;
    holdUntil?: number;
  };
  ok?: boolean;
  paymentLinks?: string[];
  paymentMessage?: string;
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

function normalizePaymentLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const link = item.trim();
    if (!link || seen.has(link)) continue;
    seen.add(link);
    links.push(link);
  }
  return links;
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
    state.message = total > 0 ? `已开始处理（共 ${total} 个账号），请耐心等待…` : '已开始处理，请耐心等待…';
    if (total > 0 && state.accounts.length === 0) {
      state.accounts = Array.from({ length: total }, (_, index) => ({
        index,
        email: `账号 ${index + 1}`,
        ok: null,
        hint: '排队中…',
      }));
    }
  } else if (body.event === 'progress') {
    const tip = (body.message || '').trim().slice(0, 80);
    if (!tip) return friendlyError(400, '进度文案无效');
    state.phase = 'processing';
    const index = Number(body.account?.index);
    if (Number.isInteger(index) && index >= 0) {
      const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
      const row = ensureAccountSlot(state, index, email);
      if (row.ok === null) row.hint = tip;
      const total = state.total || state.accounts.length || 0;
      state.message = total > 1 ? `账号 ${index + 1}/${total}：${tip}` : tip;
    } else {
      state.message = tip;
    }
  } else if (body.event === 'account_done') {
    const index = Number(body.account?.index);
    if (!Number.isInteger(index) || index < 0) return friendlyError(400, '账号序号无效');
    const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
    const row = ensureAccountSlot(state, index, email);
    row.ok = Boolean(body.account?.ok);
    delete row.hint;
    if (row.ok && body.account?.accessToken) {
      row.accessToken = body.account.accessToken;
      delete row.error;
      const holdUntil = Number(body.account.holdUntil);
      if (Number.isFinite(holdUntil) && holdUntil > 0) {
        row.holdUntil = holdUntil;
      } else {
        delete row.holdUntil;
      }
    } else {
      delete row.accessToken;
      delete row.holdUntil;
      row.error = (body.account?.error || '处理失败').slice(0, 80);
    }
    if (!state.total) state.total = Math.max(state.accounts.length, index + 1);
    const doneCount = state.accounts.filter((a) => a.ok !== null).length;
    state.phase = 'processing';
    const pending = state.accounts.filter((a) => a.ok === null).length;
    state.message =
      pending > 0
        ? `已完成 ${doneCount}/${state.total}，其余账号继续处理中…`
        : `账号已全部处理完（${doneCount}/${state.total}），正在收尾…`;
  } else if (body.event === 'finished') {
    const links = normalizePaymentLinks(body.paymentLinks);
    if (links.length) {
      state.paymentLinks = links;
    } else {
      delete state.paymentLinks;
    }
    const paymentMessage = typeof body.paymentMessage === 'string' ? body.paymentMessage.trim().slice(0, 200) : '';
    if (paymentMessage) {
      state.paymentMessage = paymentMessage;
    } else {
      delete state.paymentMessage;
    }

    const allOk = state.accounts.length > 0 && state.accounts.every((a) => a.ok === true);
    const anyOk = state.accounts.some((a) => a.ok === true);
    if (allOk) {
      state.phase = 'done';
      state.message = paymentMessage || '全部完成';
    } else if (anyOk) {
      state.phase = 'done';
      state.message = paymentMessage || '部分完成';
    } else {
      state.phase = 'failed';
      state.message = paymentMessage || '全部失败';
    }
  } else {
    return friendlyError(400, '未知事件');
  }

  await writeTask(context.env, taskId, state);
  return json({ ok: true });
};
