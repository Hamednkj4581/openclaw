# 网页控制台（Cloudflare Pages）

浏览器提交注册 / 登录任务；Pages Functions 持有 GitHub PAT，触发仓库 Actions；Actions 通过 webhook 回写进度与每账号 access token。

## 本地凭据（均未跟踪）

| 文件 | 用途 |
|------|------|
| 根目录 `PAT` | 触发 Actions、upsert GitHub Secrets；同步到 Pages 的 `GITHUB_PAT` |
| 根目录 `CLOUDFLARE_API_TOKEN` | `wrangler` 部署与创建 KV（自定义 Token，权限见下） |
| 根目录 `WEBHOOK_SECRET`（可选） | 部署时对齐 GitHub + Pages；缺失时由脚本生成 |

| 根目录 `CLOUDFLARE_ACCOUNT_ID`（可选） | Pages 不支持写进 wrangler.toml；单账号可由脚本自动生成 |

### Cloudflare API Token 权限

Dashboard → **API Tokens → Create Custom Token**：

| 范围 | 权限 |
|------|------|
| Account → Cloudflare Pages | Edit |
| Account → Workers KV Storage | Edit |
| Account → Account Settings | Read |

只用 `*.pages.dev` 时不需要 Zone DNS。不要只用「Edit Cloudflare Workers」模板（可能缺 Pages Edit）。

## 本地开发

```bash
cd web
npm install
npm run build
# 在 web/.dev.vars 配置 GITHUB_PAT、WEBHOOK_SECRET 等后：
npx wrangler pages dev dist
```

`.dev.vars` 示例（勿提交）：

```
GITHUB_PAT=...
WEBHOOK_SECRET=dev-secret
```

`GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_REF` 来自 `wrangler.toml` `[vars]`。

## 生产部署

由 skill `deploy-cloudflare-web` 执行：

```bash
python web/scripts/deploy_and_sync_webhook.py
```

会自动：

- 构建并部署到 Pages 项目 `gpt-web-console`
- Upsert GitHub Secret `WEB_CALLBACK_URL={pagesOrigin}/api/webhook`
- 首次生成并双边同步 `WEBHOOK_SECRET`（已存在则不轮换）
- 同步 Pages secret `GITHUB_PAT`

## API

| 路径 | 说明 |
|------|------|
| `POST /api/trigger` | 提交任务，返回 `taskId` |
| `POST /api/webhook` | Actions 回调（`X-Webhook-Secret`） |
| `GET /api/status?taskId=` | 友好进度 + 已完成账号的 access token |

浏览器短轮询 status；服务端不轮询 GitHub。
