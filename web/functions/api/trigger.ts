import type { Env } from '../_shared/types';
import { friendlyError, json } from '../_shared/types';
import { commitMessage, dispatchWorkflow } from '../_shared/github';
import { writeTask } from '../_shared/tasks';
import type { TaskMode, TaskState } from '../_shared/types';

const PROXY_REGIONS = new Set(['JP', 'PH']);

interface TriggerBody {
  mode?: TaskMode;
  accounts?: string;
  forwarding_emails?: string;
  enable_mfa?: boolean;
  enable_711_proxy?: boolean;
  proxy_region?: string;
  proxy_links?: string;
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

function parseProxyLinks(value: string): string[] {
  return value
    .split(/(?:\r?\n|;)+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

  const proxyRegionRaw = (body.proxy_region || '').trim().toUpperCase();
  const enableProxy =
    body.enable_711_proxy === true || (proxyRegionRaw !== '' && proxyRegionRaw !== 'NONE');
  const proxyRegion = enableProxy ? proxyRegionRaw : '';
  const proxyLinks = parseProxyLinks(body.proxy_links || '').join('\n');
  if (enableProxy) {
    if (!PROXY_REGIONS.has(proxyRegion)) {
      return friendlyError(400, '请选择有效的代理地区');
    }
    if (!proxyLinks) {
      return friendlyError(400, '启用代理时请填写至少一条代理链接');
    }
  }

  const taskId = crypto.randomUUID();
  const runName = commitMessage(mode);
  const state: TaskState = {
    mode,
    phase: 'submitted',
    message: '已提交，正在启动任务，请稍候…',
    total: 0,
    accounts: [],
    runName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeTask(context.env, taskId, state);

  const hold = Number(body.hold_minutes);
  const holdMinutes = [0, 5, 10, 15, 30].includes(hold) ? String(hold) : '15';

  const inputs: Record<string, string> = {
    commit_message: runName,
    accounts,
    web_task_id: taskId,
    enable_711_proxy: String(enableProxy),
    proxy_region: proxyRegion,
    proxy_links: enableProxy ? proxyLinks : '',
    payment_link_type: paymentLinkType,
    payment_card: paymentLinkType === 'gcash' ? paymentCard : '',
    hold_minutes: holdMinutes,
  };

  if (mode === 'register') {
    inputs.forwarding_emails = (body.forwarding_emails || '').trim();
    inputs.enable_mfa = String(body.enable_mfa !== false);
  }

  try {
    await dispatchWorkflow(context.env, mode, inputs);
  } catch {
    state.phase = 'failed';
    state.message = '提交失败，请稍后重试';
    await writeTask(context.env, taskId, state);
    return friendlyError(502, '提交失败，请稍后重试');
  }

  return json({ ok: true, taskId, runName, message: state.message });
};
