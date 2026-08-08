import type { Env, TaskMode } from './types';

const API_VERSION = '2022-11-28';

function workflowFile(mode: TaskMode): string {
  if (mode === 'register') return 'ci.yml';
  if (mode === 'bind_phone') return 'bind-phone.yml';
  return 'login.yml';
}

function githubHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'gpt-web-console',
  };
}

export type WorkflowDispatchResult =
    | { ok: true }
    | { ok: false; status: number; message: string };

/** 将 GitHub API 错误转为用户可读文案（不含 token 等敏感信息） */
export function formatGithubDispatchError(status: number, raw: string): string {
    let detail = '';
    try {
        const body = JSON.parse(raw) as { message?: string; errors?: Array<{ message?: string }> };
        const parts: string[] = [];
        if (body.message) parts.push(body.message);
        if (Array.isArray(body.errors)) {
            for (const err of body.errors) {
                if (err.message) parts.push(err.message);
            }
        }
        detail = parts.join('；');
    } catch {
        detail = raw.trim().slice(0, 160);
    }

    if (status === 401) return 'GitHub 凭据无效，请检查 Pages 上的 GITHUB_PAT';
    if (status === 403) return 'GitHub 无权限触发 Actions，请确认 PAT 含 actions:write';
    if (status === 404) return '找不到对应工作流，请确认仓库已推送最新 workflow 文件';
    if (status === 422) {
        if (/unexpected inputs/i.test(detail)) {
            return `工作流参数不匹配：${detail}`;
        }
        if (/required/i.test(detail)) {
            return `缺少必填参数：${detail}`;
        }
        return detail ? `请求参数无效：${detail}` : '请求参数无效';
    }
    if (detail) return `触发 Actions 失败（HTTP ${status}）：${detail}`;
    return `触发 Actions 失败（HTTP ${status}）`;
}

export async function dispatchWorkflow(
    env: Env,
    mode: TaskMode,
    inputs: Record<string, string>
): Promise<WorkflowDispatchResult> {
    const url =
        `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
        `/actions/workflows/${workflowFile(mode)}/dispatches`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(env),
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
                ref: env.GITHUB_REF || 'main',
                inputs,
            }),
        });
    } catch (error) {
        const tip = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 0, message: `无法连接 GitHub：${tip.slice(0, 120)}` };
    }

    if (response.status === 204) return { ok: true };

    const raw = await response.text().catch(() => '');
    return {
        ok: false,
        status: response.status,
        message: formatGithubDispatchError(response.status, raw),
    };
}

type WorkflowRun = {
  id: number;
  name?: string;
  display_title?: string;
  status?: string;
  conclusion?: string | null;
};

export async function findWorkflowRunByName(
  env: Env,
  mode: TaskMode,
  runName: string,
): Promise<WorkflowRun | null> {
  const name = runName.trim();
  if (!name) return null;
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${workflowFile(mode)}/runs?per_page=30&event=workflow_dispatch`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) return null;
  const payload = (await response.json()) as { workflow_runs?: WorkflowRun[] };
  const rows = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  return (
    rows.find((row) => (row.display_title || '').trim() === name || (row.name || '').trim() === name) ||
    null
  );
}

export async function cancelWorkflowRun(env: Env, runId: number): Promise<void> {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/runs/${runId}/cancel`;
  const response = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(env),
  });
  if (response.status === 202 || response.status === 409) return;
  if (!response.ok) throw new Error('cancel_failed');
}

export function commitMessage(mode: TaskMode): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const stamp = `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
  if (mode === 'register') return `web-register-${stamp}`;
  if (mode === 'bind_phone') return `web-bind-phone-${stamp}`;
  return `web-login-${stamp}`;
}
