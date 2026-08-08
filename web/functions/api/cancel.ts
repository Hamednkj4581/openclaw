import type { Env } from '../_shared/types';
import { appendProgressLog, friendlyError, json } from '../_shared/types';
import { cancelWorkflowRun, findWorkflowRunByName } from '../_shared/github';
import { readTask, writeTask } from '../_shared/tasks';

function requireEnv(env: Env): string | null {
  if (!env.GITHUB_PAT) return '服务未配置';
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return '服务未配置';
  if (!env.TASKS) return '服务未配置';
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const missing = requireEnv(context.env);
  if (missing) return friendlyError(503, missing);

  let body: { taskId?: string };
  try {
    body = (await context.request.json()) as { taskId?: string };
  } catch {
    return friendlyError(400, '请求格式无效');
  }

  const taskId = (body.taskId || '').trim();
  if (!taskId) return friendlyError(400, '缺少任务编号');

  const state = await readTask(context.env, taskId);
  if (!state) return friendlyError(404, '任务不存在或已过期');

  if (state.phase === 'done' || state.phase === 'failed' || state.phase === 'cancelled') {
    return json({ ok: true, message: '任务已结束', phase: state.phase });
  }

  const runName = (state.runName || '').trim();
  if (!runName) return friendlyError(400, '暂时无法取消，请稍后重试');

  let run = await findWorkflowRunByName(context.env, state.mode, runName);
  // dispatch 后 run 可能稍晚才出现，短重试几次
  for (let attempt = 0; !run && attempt < 4; attempt++) {
    await sleep(1500);
    run = await findWorkflowRunByName(context.env, state.mode, runName);
  }

  if (run) {
    const status = (run.status || '').toLowerCase();
    if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'requested' || status === 'pending') {
      try {
        await cancelWorkflowRun(context.env, run.id);
      } catch {
        return friendlyError(502, '取消失败，请稍后重试');
      }
    }
  }

  state.phase = 'cancelled';
  state.message = '任务已取消';
  appendProgressLog(state, '任务已取消');
  for (const account of state.accounts) {
    if (account.ok === null) {
      account.ok = false;
      account.error = '任务已取消';
      delete account.hint;
      appendProgressLog(account, '任务已取消');
    }
  }
  await writeTask(context.env, taskId, state);

  return json({
    ok: true,
    message: '已取消任务',
    phase: state.phase,
  });
};
