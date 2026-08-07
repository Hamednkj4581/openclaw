import type { Env } from '../_shared/types';
import { friendlyError, json } from '../_shared/types';
import { publicStatus, readTask } from '../_shared/tasks';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const taskId = (url.searchParams.get('taskId') || '').trim();
  if (!taskId) return friendlyError(400, '缺少任务编号');

  const state = await readTask(context.env, taskId);
  if (!state) return friendlyError(404, '任务不存在或已过期');

  return json(publicStatus(state));
};
