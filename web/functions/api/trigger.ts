import type { Env } from '../_shared/types';
import { friendlyError, json } from '../_shared/types';
import { commitMessage, dispatchWorkflow } from '../_shared/github';
import { writeTask } from '../_shared/tasks';
import type { TaskMode, TaskState } from '../_shared/types';

const PROXY_REGIONS = new Set(['JP', 'PH']);
const LOGIN_ACCOUNT_RE = /^\S+@\S+\.\S+$/;
const BASE32_RE = /^[A-Z2-7=]+$/i;
const BASE32_MIN_LEN = 10;

function isBase32Field(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  return compact.length >= BASE32_MIN_LEN && BASE32_RE.test(compact);
}

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
  gc_ph_api_key?: string;
  hero_sms_api_key?: string;
  hero_sms_service?: string;
  hero_sms_country?: string;
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

/** 提交前校验登录/绑定手机：注册格式 + 额外 email----password----2fa */
function validateLoginAccounts(accounts: string, label: string): string | null {
  const records = accounts.split(/(?:\r?\n|;)+/).map((item) => item.trim()).filter(Boolean);
  if (!records.length) return `请填写${label}账号`;
  for (let index = 0; index < records.length; index++) {
    const fields = records[index].split(/-{4,}/).map((part) => part.trim()).filter(Boolean);
    if (!fields.length) return `第 ${index + 1} 个账号为空`;
    if (!LOGIN_ACCOUNT_RE.test(fields[0])) {
      return `第 ${index + 1} 个账号邮箱格式无效`;
    }
    if (fields.length >= 3 && isBase32Field(fields[2])) {
      if (!fields[1]) return `第 ${index + 1} 个账号密码为空`;
      continue;
    }
    if (fields.length === 1) continue;
    if (fields.length === 2) {
      if (!fields[1]) return `第 ${index + 1} 个取件字段为空`;
      continue;
    }
    if (fields.length === 4) {
      if (fields.some((field) => !field)) {
        return `第 ${index + 1} 个 Outlook 四字段不完整`;
      }
      continue;
    }
    return `第 ${index + 1} 个账号格式错误（与注册相同：单邮箱 / 两字段取件 / Outlook 四字段，或 email----password----2fa）`;
  }
  return null;
}

function parseMode(raw: unknown): TaskMode | null {
  if (raw === 'register' || raw === 'login' || raw === 'bind_phone') return raw;
  return null;
}

/** 与 Actions 矩阵一致：按行统计非空账号条数 */
function countAccountLines(accounts: string): number {
  return accounts
    .split(/(?:\r?\n|;)+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
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

  const mode = parseMode(body.mode);
  if (!mode) return friendlyError(400, '请选择任务类型');

  const accounts = (body.accounts || '').trim();
  if (!accounts) return friendlyError(400, '请填写账号');

  if (mode === 'login' || mode === 'bind_phone') {
    const accountError = validateLoginAccounts(accounts, mode === 'bind_phone' ? '绑定手机' : '登录');
    if (accountError) return friendlyError(400, accountError);
  }

  const heroSmsApiKey = (body.hero_sms_api_key || '').trim();
  const heroSmsService = (body.hero_sms_service || '').trim();
  const heroSmsCountry = (body.hero_sms_country || '').trim();
  if (mode === 'bind_phone') {
    if (!heroSmsApiKey) return friendlyError(400, '绑定手机须填写 Hero SMS API Key');
    if (!heroSmsService) return friendlyError(400, '绑定手机须选择服务');
    if (!/^\d+$/.test(heroSmsCountry)) return friendlyError(400, '绑定手机须选择国家');
  }

  const paymentLinkType = mode === 'bind_phone' ? '未选择' : body.payment_link_type === 'gcash' ? 'gcash' : '未选择';
  const paymentCard = (body.payment_card || '').trim();
  if (paymentLinkType === 'gcash' && !paymentCard) {
    return friendlyError(400, '选择 gcash 时请填写卡密');
  }
  const gcPhApiKey = paymentLinkType === 'gcash' ? (body.gc_ph_api_key || '').trim() : '';

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
  const accountCount = countAccountLines(accounts);
  const state: TaskState = {
    mode,
    phase: 'submitted',
    message:
      accountCount > 0
        ? `已提交（共 ${accountCount} 个账号），正在启动任务，请稍候…`
        : '已提交，正在启动任务，请稍候…',
    total: accountCount,
    accounts: Array.from({ length: accountCount }, (_, index) => ({
      index,
      email: `账号 ${index + 1}`,
      ok: null,
      hint: '排队中…',
    })),
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
    gc_ph_api_key: gcPhApiKey,
    hold_minutes: holdMinutes,
  };

  if (mode === 'bind_phone') {
    inputs.hero_sms_api_key = heroSmsApiKey;
    inputs.hero_sms_service = heroSmsService;
    inputs.hero_sms_country = heroSmsCountry;
  }

  if (mode === 'register' || mode === 'login' || mode === 'bind_phone') {
    inputs.forwarding_emails = (body.forwarding_emails || '').trim();
  }

  if (mode === 'register') {
    inputs.enable_mfa = String(body.enable_mfa !== false);
  }

  const dispatched = await dispatchWorkflow(context.env, mode, inputs);
  if (!dispatched.ok) {
    const tip = dispatched.message || '提交失败，请稍后重试';
    state.phase = 'failed';
    state.message = tip;
    await writeTask(context.env, taskId, state);
    return friendlyError(dispatched.status >= 400 && dispatched.status < 600 ? dispatched.status : 502, tip);
  }

  return json({ ok: true, taskId, runName, message: state.message });
};
