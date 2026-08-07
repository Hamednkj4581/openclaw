---
name: deploy-cloudflare-web
description: 构建并部署 web/ 到 Cloudflare Pages，自动维护 GitHub Secret WEB_CALLBACK_URL 与 webhook 相关密钥。在部署网页控制台、更新回调地址、或改完 web/ 需要上线时使用。
---

# 部署 Cloudflare 网页控制台

## 触发场景

- 用户要求部署 / 更新网页控制台
- 修改了 `web/` 前端或 Pages Functions，需要上线
- 需要维护或纠正 Actions 回调地址 `WEB_CALLBACK_URL`

## 硬性约定

- GitHub 操作一律用仓库根目录 `PAT` + REST；**禁止先试 `gh`**。
- Cloudflare 鉴权用根目录未跟踪文件 `CLOUDFLARE_API_TOKEN`（整文件即为 token）。
- 不得回显、提交或复制 `PAT` / `CLOUDFLARE_API_TOKEN` / `WEBHOOK_SECRET` 全文。
- 不得把凭据写入 remote URL 或日志。

## 前置

1. 根目录存在有效 `PAT`（规则见 `maintain-github-pat`）。
2. 根目录存在 `CLOUDFLARE_API_TOKEN`（自定义 Token，权限见下节）。
3. 可选根目录 `WEBHOOK_SECRET`：有则每次部署对齐 GitHub + Pages；无且 GitHub 也没有时由脚本生成并落盘。
4. 已安装 Node.js；部署脚本会在 `web/` 内执行 `npm ci`/`npm install` 与 `wrangler`。
5. 若需 upsert GitHub Secrets：本机可 `pip install pynacl`。

## Cloudflare API Token 权限

在 Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**：

| 范围 | 权限 | 用途 |
|------|------|------|
| Account → Cloudflare Pages | Edit | 创建/部署 Pages、写入 Pages secrets |
| Account → Workers KV Storage | Edit | 创建并绑定 `TASKS` KV |
| Account → Account Settings | Read | 自动读取 `account_id`（单账号建议加上） |

- Account resources：选目标 Cloudflare 账号。
- 仅用 `*.pages.dev` 时**不需要** Zone / DNS 权限。
- 勿依赖「Edit Cloudflare Workers」模板 alone：可能缺少 **Cloudflare Pages: Edit**。

## 执行步骤

在仓库根目录运行（不要手工拼 webhook URL，除非脚本失败后排查）：

```bash
python web/scripts/deploy_and_sync_webhook.py
```

脚本会：

1. 读取 `CLOUDFLARE_API_TOKEN` 与 `PAT`
2. 解析 `account_id`（环境变量 / 根目录 `CLOUDFLARE_ACCOUNT_ID` 文件；缺失且仅一账号时自动写入该文件）
3. 若 KV `TASKS` 仍是占位 id，则创建并回写真实 id
4. `web/` 下构建前端，`wrangler pages deploy`
5. Upsert GitHub Secret `WEB_CALLBACK_URL={origin}/api/webhook`
6. 同步 `WEBHOOK_SECRET`：优先本地文件；否则 GitHub 已有则不轮换；都没有则生成并写入本地文件 + GitHub + Pages
7. 将根目录 `PAT` 同步为 Pages secret `GITHUB_PAT`

## 成功标准

- 脚本打印部署 URL（`*.pages.dev`）
- 明确提示 `WEB_CALLBACK_URL` 已更新
- 不打印任何 secret 值
- 用户可用该 URL 打开控制台

## 失败处理

- 缺少凭据文件：停止并说明缺哪个文件
- 多 Cloudflare 账号：要求在根目录 `CLOUDFLARE_ACCOUNT_ID` 文件填写目标账号
- `WEBHOOK_SECRET` 已在 GitHub 但 Pages 缺失：提示手动对齐同一值（无法从 GitHub 读出 secret）
- 禁止用轮换 secret 的方式“猜”修复进行中的任务
