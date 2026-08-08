import type { AccountResult, Env, TaskState } from '../_shared/types';
import { appendProgressLog, friendlyError, json } from '../_shared/types';
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
    paymentLink?: string;
    paymentQr?: string;
    paymentQrUrl?: string;
    paymentError?: string;
    error?: string;
    holdUntil?: number;
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
    state.message = total > 0 ? `已开始处理（共 ${total} 个账号），请耐心等待…` : '已开始处理，请耐心等待…';
    appendProgressLog(state, state.message);
    if (total > 0 && state.accounts.length === 0) {
      state.accounts = Array.from({ length: total }, (_, index) => {
        const row: AccountResult = {
          index,
          email: `账号 ${index + 1}`,
          ok: null,
          hint: '排队中…',
        };
        appendProgressLog(row, '排队中…');
        return row;
      });
    }
  } else if (body.event === 'progress') {
    const tip = (body.message || '').trim().slice(0, 160);
    if (!tip) return friendlyError(400, '进度文案无效');
    state.phase = 'processing';
    const index = Number(body.account?.index);
    if (Number.isInteger(index) && index >= 0) {
      const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
      const row = ensureAccountSlot(state, index, email);
      appendProgressLog(row, tip);
      // 进行中或成功后的后续阶段（提链/保持）都更新最新提示
      if (row.ok === null || row.ok === true) {
        row.hint = tip;
      }
      const total = state.total || state.accounts.length || 0;
      state.message = total > 1 ? `账号 ${index + 1}/${total}：${tip}` : tip;
    } else {
      appendProgressLog(state, tip);
      state.message = tip;
    }
  } else if (body.event === 'account_done') {
    const index = Number(body.account?.index);
    if (!Number.isInteger(index) || index < 0) return friendlyError(400, '账号序号无效');
    const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
    const row = ensureAccountSlot(state, index, email);
    const prevOk = row.ok;
    const prevLink = row.paymentLink || '';
    const prevQr = row.paymentQr || '';
    const prevHold = row.holdUntil || 0;
    const prevPaymentError = row.paymentError || '';
    const ok = Boolean(body.account?.ok);
    row.ok = ok;

    if (!ok) {
      delete row.accessToken;
      delete row.paymentLink;
      delete row.paymentQr;
      delete row.paymentQrUrl;
      delete row.paymentError;
      delete row.holdUntil;
      delete row.hint;
      row.error = (body.account?.error || '处理失败').slice(0, 160);
      appendProgressLog(row, row.error);
    } else {
      delete row.error;
      if (body.account?.accessToken) {
        row.accessToken = body.account.accessToken;
        if (prevOk !== true) appendProgressLog(row, '账号处理成功，已回传结果');
      }
      const paymentLink = (body.account?.paymentLink || '').trim();
      if (paymentLink) {
        row.paymentLink = paymentLink;
        delete row.hint;
        if (paymentLink !== prevLink) appendProgressLog(row, '支付链接已更新');
      }
      const paymentQr = (body.account?.paymentQr || '').trim();
      if (paymentQr.startsWith('data:image')) {
        row.paymentQr = paymentQr;
        if (paymentQr !== prevQr) appendProgressLog(row, '支付二维码已更新');
      }
      const paymentQrUrl = (body.account?.paymentQrUrl || '').trim();
      if (paymentQrUrl) {
        row.paymentQrUrl = paymentQrUrl;
      }
      const paymentErrorRaw = body.account?.paymentError;
      if (typeof paymentErrorRaw === 'string') {
        const paymentError = paymentErrorRaw.trim().slice(0, 160);
        if (paymentError) {
          row.paymentError = paymentError;
          if (paymentError !== prevPaymentError) appendProgressLog(row, paymentError);
        } else delete row.paymentError;
      } else if (paymentLink && (paymentQr || row.paymentQr)) {
        delete row.paymentError;
      }
      const holdUntil = Number(body.account?.holdUntil);
      if (Number.isFinite(holdUntil) && holdUntil > 0) {
        row.holdUntil = holdUntil;
        if (holdUntil !== prevHold) appendProgressLog(row, '已进入保持等待');
      }
      // 仅补传支付链接时保留已有 hint，直到拿到链接
      if (paymentLink || row.paymentLink) {
        delete row.hint;
      }
    }

    if (!state.total) state.total = Math.max(state.accounts.length, index + 1);
    const doneCount = state.accounts.filter((a) => a.ok !== null).length;
    state.phase = 'processing';
    const pending = state.accounts.filter((a) => a.ok === null).length;
    const tip = (body.account?.paymentLink || '').trim()
      ? '支付链接已更新'
      : pending > 0
        ? `已完成 ${doneCount}/${state.total}，其余账号继续处理中…`
        : `账号已全部处理完（${doneCount}/${state.total}），正在收尾…`;
    state.message = tip;
    appendProgressLog(state, tip);
  } else if (body.event === 'finished') {
    delete state.paymentLinks;
    delete state.paymentMessage;

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
    appendProgressLog(state, state.message);
  } else {
    return friendlyError(400, '未知事件');
  }

  await writeTask(context.env, taskId, state);
  return json({ ok: true });
};
