import type { Env } from '../_shared/types';
import { friendlyError, json } from '../_shared/types';
import { commitMessage, dispatchWorkflow } from '../_shared/github';
import { writeTask } from '../_shared/tasks';
import type { TaskMode, TaskState } from '../_shared/types';

interface TriggerBody {
  mode?: TaskMode;
  accounts?: string;
  forwarding_emails?: string;
  enable_mfa?: boolean;
  enable_711_proxy?: boolean;
  payment_link_type?: string;
  payment_card?: string;
  hold_minutes?: number | string;
}

function requireEnv(env: Env): string | null {
  if (!env.GITHUB_PAT) return '服务未配置';
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return '服务未配置';
  if (!env.WEBHOOK_SECRET) return '服务未配置';
  if (!env.TASKS) return '服务未配置';
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const missing = requireEnv(context.env);
  if (missing) return friendlyError(503, missing);

  let body: TriggerBody;
  try {
    body = (await context.request.json()) as TriggerBody;
  } catch {
    return friendlyError(400, '请求格式无效');
  }

  const mode = body.mode === 'login' ? 'login' : body.mode === 'register' ? 'register' : null;
  if (!mode) return friendlyError(400, '请选择任务类型');

  const accounts = (body.accounts || '').trim();
  if (!accounts) return friendlyError(400, '请填写账号');

  const paymentLinkType = body.payment_link_type === 'gcash' ? 'gcash' : '未选择';
  const paymentCard = (body.payment_card || '').trim();
  if (paymentLinkType === 'gcash' && !paymentCard) {
    return friendlyError(400, '选择 gcash 时请填写卡密');
  }

  const taskId = crypto.randomUUID();
  const state: TaskState = {
    mode,
    phase: 'submitted',
    message: '已提交，等待开始处理',
    total: 0,
    accounts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeTask(context.env, taskId, state);

  const inputs: Record<string, string> = {
    commit_message: commitMessage(mode),
    accounts,
    web_task_id: taskId,
    enable_711_proxy: String(Boolean(body.enable_711_proxy)),
    payment_link_type: paymentLinkType,
    payment_card: paymentLinkType === 'gcash' ? paymentCard : '',
  };

  if (mode === 'register') {
    inputs.forwarding_emails = (body.forwarding_emails || '').trim();
    inputs.enable_mfa = String(body.enable_mfa !== false);
  } else {
    const hold = Number(body.hold_minutes);
    inputs.hold_minutes = [5, 10, 15, 30].includes(hold) ? String(hold) : '15';
  }

  try {
    await dispatchWorkflow(context.env, mode, inputs);
  } catch {
    state.phase = 'failed';
    state.message = '提交失败，请稍后重试';
    await writeTask(context.env, taskId, state);
    return friendlyError(502, '提交失败，请稍后重试');
  }

  return json({ ok: true, taskId, message: state.message });
};
