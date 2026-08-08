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

export async function dispatchWorkflow(
  env: Env,
  mode: TaskMode,
  inputs: Record<string, string>
): Promise<void> {
  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${workflowFile(mode)}/dispatches`;

  const response = await fetch(url, {
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

  if (response.status !== 204) {
    throw new Error('trigger_failed');
  }
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
