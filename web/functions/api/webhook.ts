import type { AccountResult, Env, TaskPhase, TaskState } from '../_shared/types';
import { appendProgressLog, friendlyError, json } from '../_shared/types';
import {
  ensureAccount,
  readTask,
  writeAccount,
  writeTask,
  writeTaskMeta,
} from '../_shared/tasks';

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
    password?: string;
    otpSecret?: string;
    paymentLink?: string;
    paymentQr?: string;
    paymentError?: string;
    error?: string;
    holdUntil?: number;
  };
  ok?: boolean;
}

function isTerminal(phase: TaskPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

function summarizeProcessing(state: TaskState, tip: string): string {
  const total = state.total || state.accounts.length || 0;
  const doneCount = state.accounts.filter((a) => a.ok !== null).length;
  const pending = state.accounts.filter((a) => a.ok === null).length;
  if (total <= 1) return tip;
  if (pending > 0) return `已完成 ${doneCount}/${total}，其余账号继续处理中…`;
  return `账号已全部处理完（${doneCount}/${total}），正在收尾…`;
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
    if (isTerminal(state.phase)) {
      return json({ ok: true, ignored: true });
    }
    const total = Number(body.total) || 0;
    state.total = total;
    state.phase = 'processing';
    state.message = total > 0 ? `已开始处理（共 ${total} 个账号），请耐心等待…` : '已开始处理，请耐心等待…';
    appendProgressLog(state, state.message);

    const accounts: AccountResult[] = [];
    if (total > 0) {
      for (let index = 0; index < total; index++) {
        // 已有账号进度则保留，避免 started 重放清空并行回传
        const existing = state.accounts.find((a) => a.index === index);
        if (existing) {
          accounts.push(existing);
          continue;
        }
        const row: AccountResult = {
          index,
          email: `账号 ${index + 1}`,
          ok: null,
          hint: '排队中…',
        };
        appendProgressLog(row, '排队中…');
        accounts.push(row);
      }
    }
    state.accounts = accounts;
    await writeTask(context.env, taskId, state);
    return json({ ok: true });
  }

  if (body.event === 'progress') {
    const tip = (body.message || '').trim().slice(0, 160);
    if (!tip) return friendlyError(400, '进度文案无效');

    // 任务已结束后忽略迟到进度，避免把终态打回 processing
    if (isTerminal(state.phase)) {
      return json({ ok: true, ignored: true });
    }

    const index = Number(body.account?.index);
    if (Number.isInteger(index) && index >= 0) {
      const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
      const row = await ensureAccount(context.env, taskId, index, email);
      // 已失败账号不再被其它/迟到 progress 改写提示
      if (row.ok === false) {
        return json({ ok: true, ignored: true });
      }
      appendProgressLog(row, tip);
      if (row.ok === null || row.ok === true) {
        row.hint = tip;
      }
      await writeAccount(context.env, taskId, row);

      state.phase = 'processing';
      const total = state.total || Math.max(state.accounts.length, index + 1);
      if (!state.total) state.total = total;
      state.message = total > 1 ? `账号 ${index + 1}/${total}：${tip}` : tip;
      await writeTaskMeta(context.env, taskId, state);
    } else {
      appendProgressLog(state, tip);
      state.phase = 'processing';
      state.message = tip;
      await writeTaskMeta(context.env, taskId, state);
    }
    return json({ ok: true });
  }

  if (body.event === 'account_done') {
    const index = Number(body.account?.index);
    if (!Number.isInteger(index) || index < 0) return friendlyError(400, '账号序号无效');
    const email = (body.account?.email || '').trim() || `账号 ${index + 1}`;
    const row = await ensureAccount(context.env, taskId, index, email);
    const prevOk = row.ok;
    const prevLink = row.paymentLink || '';
    const prevQr = row.paymentQr || '';
    const prevHold = row.holdUntil || 0;
    const prevPaymentError = row.paymentError || '';
    const ok = Boolean(body.account?.ok);
    row.ok = ok;

    if (!ok) {
      delete row.accessToken;
      delete row.password;
      delete row.otpSecret;
      delete row.paymentLink;
      delete row.paymentQr;
      delete row.paymentError;
      delete row.holdUntil;
      delete row.hint;
      const incoming = (body.account?.error || '处理失败').trim().slice(0, 240) || '处理失败';
      const generic = new Set(['注册失败', '登录失败', '处理失败', '未拿到结果']);
      // Node 已回传具体原因时，不要被工作流兜底的笼统文案覆盖
      if (row.error && generic.has(incoming) && !generic.has(row.error)) {
        appendProgressLog(row, row.error);
      } else {
        row.error = incoming;
        appendProgressLog(row, row.error);
      }
    } else {
      delete row.error;
      if (body.account?.accessToken) {
        row.accessToken = body.account.accessToken;
        if (prevOk !== true) appendProgressLog(row, '账号处理成功，已回传结果');
      }
      const password = (body.account?.password || '').trim();
      if (password) row.password = password;
      const otpSecret = (body.account?.otpSecret || '').trim();
      if (otpSecret) row.otpSecret = otpSecret;
      const paymentLink = (body.account?.paymentLink || '').trim();
      if (paymentLink) {
        row.paymentLink = paymentLink;
        delete row.hint;
        if (paymentLink !== prevLink) appendProgressLog(row, '支付链接已更新');
      }
      const paymentQr = (body.account?.paymentQr || '').trim();
      if (paymentQr.startsWith('data:image')) {
        row.paymentQr = paymentQr;
        if (paymentQr !== prevQr) appendProgressLog(row, '支付二维码图片已更新');
      }
      delete row.paymentQrUrl;
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
      if (paymentLink || row.paymentLink) {
        delete row.hint;
      }
    }

    // 账号终态单独落键，不被其它账号的 progress 覆盖
    await writeAccount(context.env, taskId, row);

    // 任务已结束时仍接受迟到的 account_done（补真实成败），但不重开 phase、不改总文案
    if (isTerminal(state.phase)) {
      return json({ ok: true });
    }

    if (!state.total) state.total = Math.max(state.accounts.length, index + 1);
    // 用刚写入的账号刷新内存视图再汇总
    const merged = await readTask(context.env, taskId);
    if (merged) {
      state.accounts = merged.accounts;
      state.total = merged.total || state.total;
    }
    state.phase = 'processing';
    const tip = (body.account?.paymentLink || '').trim()
      ? '支付链接已更新'
      : summarizeProcessing(state, '账号状态已更新');
    state.message = tip;
    appendProgressLog(state, tip);
    await writeTaskMeta(context.env, taskId, state);
    return json({ ok: true });
  }

  if (body.event === 'finished') {
    delete state.paymentLinks;
    delete state.paymentMessage;

    // 以账号键聚合结果为准（避免只看可能过期的内存快照）
    const latest = await readTask(context.env, taskId);
    if (latest) {
      state.accounts = latest.accounts;
      state.total = latest.total || state.total;
    }

    // Actions 侧已全部结束；若仍有账号缺终态回传，如实记为未收到结果（主因靠账号独立 KV 避免丢失）
    const pendingRows = state.accounts.filter((a) => a.ok === null);
    if (pendingRows.length > 0) {
      await Promise.all(
        pendingRows.map(async (account) => {
          account.ok = false;
          account.error = '未收到结果回传';
          delete account.hint;
          appendProgressLog(account, account.error);
          await writeAccount(context.env, taskId, account);
        }),
      );
    }

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
    await writeTaskMeta(context.env, taskId, state);
    return json({ ok: true });
  }

  return friendlyError(400, '未知事件');
};
