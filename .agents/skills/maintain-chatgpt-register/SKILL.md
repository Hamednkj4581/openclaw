---
name: maintain-chatgpt-register
description: 基于 GitHub Actions 实测结果维护本仓库的 ChatGPT 注册、Outlook OAuth2/IMAP、CapSolver 和账号矩阵工作流。
---

# 维护 ChatGPT 注册项目

## 必须遵守

- 仓库默认只使用 `main` 一个分支，所有修改直接在 `main` 上进行；不得自行创建 feature、fix 或其他分支。只有用户主动、明确要求增加其他分支时才可例外，并在任务完成后按用户要求保留或清理。
- 修改仓库文件前，必须先检查当前分支最近一次 GitHub Actions 运行；若该运行对应当前分支的最新提交或该运行无任何错误，可直接作为基线，否则必须重新触发并等待运行完成。不得在缺少有效基线的情况下开始修改，因为需要从基线获取调试数据来辅助修改。
- GitHub PAT 位于根目录 `PAT` 文件，规则见 `maintain-github-pat` skill。
- `测试邮箱.txt` 仅存放待注册账号行（作为 `accounts` 输入），必须保持未跟踪。Outlook 格式为 `email----email_password----client_id----refresh_token`，iCloud/网页取件格式为 `email----API_KEY`，也可为单邮箱一行。
- `forward_mailboxes.txt` 存放转发收件箱的 Outlook 凭据（`email----password----client_id----refresh_token`，可多行），必须保持未跟踪；对应 GitHub Secret 名为 `FORWARD_MAILBOXES`。
- `accounts` 支持三种记录混用：单邮箱、Outlook 4 字段、iCloud/网页取件 2 字段。单邮箱账号依赖 workflow 输入 `forwarding_emails`（当前仅支持一个转发邮箱）登录对应转发箱，并按收件人过滤验证邮件。
- PAT 的读取、校验、警告与禁止删除等规则见 `maintain-github-pat` skill，本 skill 不重复定义。
- 不覆盖或提交用户无关改动。截图、DOM、日志、下载产物和凭据不得提交。
- 以 Actions 的实时日志、URL、标题、截图和脱敏 DOM 为准，不凭选择器报错猜测页面状态。

## 修改循环

1. 检查 `git status`，确认位于 `main`（用户主动明确要求其他分支时除外），并检查工作流和相关源码。
2. 修改前从 `PAT` 读取 token；用 `.github/scripts/sync_forward_mailboxes.py` **每次触发前**把 `forward_mailboxes.txt` upsert 到 Secret `FORWARD_MAILBOXES`（单次 API，可忽略性能影响），再触发当前工作分支的 `ci.yml`，等待运行结束。账号输入取自 `测试邮箱.txt`。
3. 检查每个 `register (N)` job 的结论；不能只看工作流顶层结论，因为注册任务使用了 `continue-on-error`。
4. 注册失败时下载该账号的失败日志和 `evidence-N`，结合最后几个阶段的 URL、标题、截图和 DOM 确定失败点。敏感数据只在进程内使用，产物下载到仓库外的临时目录。
5. 先分类再处理：
   - 页面状态、选择器、状态机或工作流错误：进行最小修改，并尽量兼容新旧页面。
   - `invalid_grant`、refresh token 过期、`invalid_client`、IMAP 权限或账号无效：停止修改，告知用户更换凭据或修复权限。
   - CapSolver 密钥无效、余额不足或挑战未接受：明确报告对应阶段，不用延长超时掩盖问题。
6. 修改后运行 `npm run typecheck` 和 `npm run build`，复查 diff，确保没有凭据或调试产物。
7. 仅提交并推送本次修改的文件，再次触发 Actions；重复检查、修改和验证，直到 `register (N)` 成功或确认是外部阻塞。

## 注册流程约束

- 浏览器启动前使用 refresh token 交换 access token，并用 OAuth2 预检 Outlook IMAP；单个账号失败不得影响其他矩阵任务。
- 注册流程必须按页面状态分支处理邮箱、密码、邮件验证链接、六位验证码、个人信息和登录成功页面，不得假设顺序固定。例如验证码后可能进入 `auth.openai.com/about-you`，此时应继续处理个人信息，不能仍按验证码阶段直接判定失败。
- 选择通用 `Continue` 按钮时排除 Google 等 OAuth 按钮；仅在对应字段实际存在时填写密码或个人信息。
- 出现 Turnstile 时使用 CapSolver 求解，并确认 token 已被页面接受；余额接口成功不代表挑战成功。
- 只有进入已登录的 ChatGPT 页面才算注册成功；MFA 默认开启，仅在工作流输入明确关闭时跳过配置。开启 MFA 失败时只告警，不得阻断后续 session/cookie 导出与结果写入。
- 关键阶段和异常均保存配对的截图与脱敏 DOM。证据名称使用账号索引和步骤名，不含邮箱、验证码、密码、token、Cookie 或验证链接。

## 工作流约束

- 忽略账号输入空行；任何非空行格式错误时在矩阵启动前终止。使用四个或更多连续连字符拆分字段，并保留重复邮箱；单邮箱行无需分隔符。
- 存在单邮箱账号时，必须能从 `forwarding_emails` + `FORWARD_MAILBOXES` 解析出唯一转发箱凭据；写入 `EMAIL`（注册邮箱）与 `MAILBOX_EMAIL`/`CLIENT_ID`/`REFRESH_TOKEN`（转发箱）。
- 矩阵只传账号索引，保持 `fail-fast: false`；账号与转发箱字段写入环境前全部掩码。
- `CAPSOLVER_API_KEY` 只能来自 GitHub Secret。每个账号独立上传结果和完整过程证据。
- 每次注册生成新 ChatGPT 密码，并在登录成功后从 `/api/auth/session` 提取 accessToken 写入结果；只有启用 MFA 时才写入 OTP 密钥。结果格式：`email----password----accessToken----时间`，启用 MFA 时为 `email----password----otpSecret----accessToken----时间`。
- 额外导出截图格式的 `session.json`（`user`/`expires`/`account`/`accessToken`/`sessionToken`/`authProvider`）：session 接口字段 + Cookie 中的 `sessionToken`，与文本结果一并上传 Artifact。
- 注册成功后额外按邮箱导出 Cookie-Editor JSON（如 `user@example.com.json`，对齐 CursorCookie 字段）；汇总阶段将各账号的 `session.json` 与 cookie 打进 `sessions-and-cookies.zip`。

## 成功标准

- `npm run typecheck` 和 `npm run build` 通过。
- 每个目标 `register (N)` job 成功，页面进入已登录 ChatGPT 状态。
- 结果产物完整，日志、证据、提交和回复均未泄露凭据。
