import type { Env, TaskMode } from './types';

const API_VERSION = '2022-11-28';

function workflowFile(mode: TaskMode): string {
  return mode === 'register' ? 'ci.yml' : 'login.yml';
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
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'gpt-web-console',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || 'main',
      inputs,
    }),
  });

  if (response.status !== 204) {
    // 不把 GitHub 原始响应透传给浏览器
    throw new Error('trigger_failed');
  }
}

export function commitMessage(mode: TaskMode): string {
  // Cloudflare Workers 默认 UTC；任务名统一按上海时区
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
  return mode === 'register' ? `web-register-${stamp}` : `web-login-${stamp}`;
}
