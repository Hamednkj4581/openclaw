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
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return mode === 'register' ? `web-register-${stamp}` : `web-login-${stamp}`;
}
