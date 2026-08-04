---
name: maintain-chatgpt-register
description: 维护和调试本仓库的 ChatGPT 注册自动化、Outlook OAuth2/IMAP 邮件验证、CapSolver Turnstile 处理及 GitHub Actions 矩阵任务。修改注册流程、更新页面选择器、诊断工作流失败、调整账号输入或反复测试 Actions 时使用。
---

# 维护 ChatGPT 注册项目

## 适用范围

本仓库只用于 ChatGPT 注册自动化。除非用户明确要求变更，否则必须保持以下约束：

- 工作流账号格式：`email----email_password----client_id----refresh_token`。
- 忽略空行；任何非空行格式错误时，在启动 runner 前立即终止。
- 保留重复邮箱。
- 每个账号使用独立的矩阵任务运行；单个账号失败不得取消其他账号。
- 为每个 ChatGPT 账号生成新密码，并将密码写入结果。
- 仅当工作流输入明确开启时启用 ChatGPT MFA，默认关闭。
- 通过 OAuth2 IMAP 直接读取 Outlook 验证邮件。
- 必须配置 `CAPSOLVER_API_KEY`；缺失或无效时立即报错退出。
- 不得在文件中打印、提交或保存真实账号、refresh token、PAT 或 API 密钥。

## 仓库结构

- `src/app.ts`：浏览器生命周期和注册状态机。
- `src/outlookMail.ts`：Microsoft refresh token 交换、IMAP 轮询以及验证码/验证链接提取。
- `src/capsolver.ts`：Turnstile Hook、任务创建、结果轮询和 token 注入。
- `src/patches.ts`：Puppeteer XPath 辅助方法和明确的选择器错误。
- `.github/workflows/ci.yml`：输入校验、每账号矩阵任务、密钥掩码、产物及结果合并。
- `package.json`：`typecheck` 和 `build` 命令。

编辑前先读取相关文件。以实时 OpenAI 页面和 Actions 日志为准，因为选择器和注册阶段可能随时变化。

## 修改流程

1. 检查 `git status`，不得覆盖用户无关的改动。
2. 读取与错误有关的文件。
3. 在启动浏览器注册前，先逐个验证邮箱凭据可用性；任一邮箱不可用时不得进入该邮箱的注册流程。
4. Actions 失败时，先检查失败任务日志并下载截图及 DOM 快照，再修改选择器。
5. 根据页面 URL、标题、截图和 DOM 快照判断真实状态，不能只根据最后一条选择器错误判断。
6. 进行最小且可感知页面状态的修改；可行时同时兼容新旧流程。
7. 运行：

```bash
npm run typecheck
npm run build
```

8. 检查已编辑文件的 lint。
9. 默认提交并推送本次修改；提交前必须复查 diff，排除 `.env*`、下载的产物、截图、DOM 快照和凭据。如果工作区包含用户无关改动，只提交本次修改涉及的文件，不得擅自纳入或覆盖其他改动。
10. 推送后默认使用当前分支自动触发工作流并监控账号矩阵任务，而不是只看工作流顶层结论；仅当用户明确要求不触发，或修改内容确定不适合运行工作流时跳过并说明原因。
11. 提交、推送或触发工作流前，使用不会打印凭据的方式检查 GitHub CLI/remote 认证。项目没有可用 PAT 或 GitHub CLI 登录态时，必须询问用户输入 PAT；不得猜测、伪造或把 PAT 写入仓库文件、remote URL、回复及持久化命令历史。
12. 仅针对代码或 Actions 缺陷继续修复。遇到 Outlook refresh token 过期等外部凭据错误时停止，并明确告知用户。

## 邮箱可用性预检

浏览器注册开始前必须先执行邮箱预检，不能等到 OpenAI 已发送验证邮件后才发现邮箱不可用：

1. 校验邮箱、`client_id` 和 `refresh_token` 均存在且格式可解析；邮箱密码字段仍只按既有输入协议保留。
2. 使用 refresh token 交换 Microsoft access token。
3. 使用 OAuth2 登录 Outlook IMAP，并确认至少可以选择和读取收件箱；需要读取垃圾邮件时也要验证对应文件夹可访问。
4. 预检成功后才记录注册开始时间并启动该邮箱的浏览器流程。
5. 预检失败时输出可操作的结构化错误日志，至少包含：脱敏邮箱、失败阶段、错误类别、Microsoft/IMAP 状态码或响应码、服务端错误名称与脱敏后的错误说明、是否可重试、建议处理方式。不得输出 access token、refresh token、邮箱密码、邮件正文或验证链接。
6. 明确区分输入格式错误、DNS/网络/TLS 错误、token 交换失败、`invalid_grant`、`invalid_client`、IMAP 认证失败、IMAP 权限不足、邮箱文件夹不可访问和超时；不得只输出“邮箱不可用”或原始异常对象。
7. 多账号运行时，一个邮箱预检失败只终止对应矩阵任务，不得阻止其他邮箱继续执行。

## OpenAI 注册流程

注册逻辑必须感知页面状态，不得假设页面顺序固定：

1. 打开 `https://chatgpt.com/`，选择免费注册入口。
2. 出现 Turnstile 时进行求解。
3. 输入邮箱，点击精确匹配且非 Google OAuth 的 `Continue` 按钮。
4. 检查跳转后的 URL 和页面：
   - 密码表单：输入生成的密码。
   - `auth.openai.com/email-verification`：轮询 Outlook 并打开验证链接。
   - 验证码表单：输入六位验证码。
5. 验证后，仅在页面存在可用密码输入框时设置密码。
6. 仅在个人信息字段存在时填写资料。
7. 确认已跳转到登录后的 ChatGPT 页面，才能判定注册成功。
8. 仅在用户启用 MFA 时执行两步验证配置。

选择器规则：

- 优先使用稳定属性和精确规范化后的按钮文本。
- 选择 `Continue` 等通用文本时，必须明确排除 OAuth 按钮。
- 仅对预期的网络跳转使用较长超时；不得用长时间等待掩盖错误页面状态。
- 不仅在错误时记录页面证据：首次打开 ChatGPT、Turnstile 处理前后、点击注册入口后、提交邮箱前后、进入密码/邮件验证/验证码/个人信息页面时、提交各表单后、登录成功确认时，以及任何异常发生时，都必须保存截图和对应 DOM 快照。
- 每份截图和 DOM 快照必须使用相同的步骤编号或时间戳关联，并同时记录脱敏后的 URL、页面标题和阶段名称，以便页面结构变化时快速对比。
- DOM 快照优先保存当前主文档的序列化 HTML；关键控件位于 frame 时还要分别保存相关 frame 的 DOM。保存前必须移除或遮蔽密码、token、验证码、OTP 密钥、Cookie、Authorization 内容及其他敏感输入值。
- 选择器缺失时，结合 URL、标题、截图和 DOM 快照调整状态机。
- 截图和 DOM 快照操作必须有独立超时；采集失败要记录具体原因，但不得让证据采集掩盖原始流程错误或无限挂起 runner。
- 截图和 DOM 快照只作为临时/Actions 调试产物上传，不得提交到 Git；产物名称必须包含账号矩阵索引和步骤名，且不得包含完整邮箱或其他凭据。

## Outlook OAuth2 和 IMAP

- 使用输入的 `client_id` 和 `refresh_token`。邮箱密码继续作为工作流格式字段保留，但不是 IMAP 的主要认证方式。
- 通过 Microsoft common v2 token 端点交换 refresh token。
- 除非已确认凭据签发方式兼容，否则不要强制传入新 scope；已有 refresh token 可能自带兼容 scope。
- 安全连接 Outlook IMAP，并检查收件箱和垃圾邮件文件夹。
- 只处理注册开始后收到的近期 OpenAI/ChatGPT 邮件。
- 同时支持验证链接和六位验证码。
- 不得记录 access token、refresh token、邮件正文或验证链接。

正确区分 OAuth 错误：

- `invalid_grant` 且包含 “grant is expired” 或 “sign in again”：refresh token 已不可用，必须让用户重新登录并提供新 token；重试或修改选择器无法修复。
- `invalid_client`：通常表示 `client_id` 与 token 或应用不匹配。
- OAuth 成功但 IMAP 认证失败：检查 token 是否具有 IMAP 权限，以及邮箱是否允许 IMAP 访问。

## CapSolver 和 Turnstile

- 启动主流程前校验 API 密钥。
- 在首次导航前使用 `evaluateOnNewDocument` 安装 Turnstile Hook。
- 在主页面和所有 frame 中检测 Turnstile，并尽可能捕获 sitekey、action 和 cdata。
- 使用 `AntiTurnstileTaskProxyLess` 求解，将 token 注入响应字段和回调；没有任何注入目标接受 token 时必须报错。
- 在可能触发新挑战的页面跳转后再次执行检测。
- CapSolver 余额接口成功只说明 API 密钥有效，不代表页面挑战已被检测或接受。

## GitHub Actions 固定约束

修改 `.github/workflows/ci.yml` 时必须保持：

- 使用四个或更多连续连字符拆分字段，以兼容很长的密码分隔内容。
- 生成矩阵 ID 前校验所有输入行。
- 矩阵只传账号索引，在各账号任务内部提取字段。
- 写入 `GITHUB_ENV` 前，对四个账号字段全部执行掩码处理。
- CapSolver 密钥只能来自 `${{ secrets.CAPSOLVER_API_KEY }}`。
- 保持 `fail-fast: false`，并为每个账号独立上传结果和失败截图。
- 为每个账号独立上传所有关键步骤的截图和脱敏 DOM 快照，不得只上传失败时的最后一张截图。
- 必须检查 `register (N)` 任务结论。由于存在 `continue-on-error`，注册失败时工作流顶层仍可能显示成功。

## Actions 验证循环

默认执行以下触发和持续测试循环：

1. 确认当前分支和提交已经推送。
2. 使用 `gh workflow run` 触发，不能把凭据写入仓库文件。
3. 记录运行 URL 和 ID。
4. 监控运行直到结束。
5. 查询每个任务的结论。
6. 下载并检查对应账号的关键步骤截图和 DOM 快照产物；`register (N)` 失败时还要获取 `--log-failed` 日志。
7. 修复代码问题，执行本地验证，然后提交、推送并重新触发；遇到用户无关改动时仍只提交本次修改文件。
8. 注册成功时结束；遇到需要用户处理的外部阻塞时停止。

不得在回复或持久化的命令历史中暴露 PAT。用户在聊天中粘贴过 PAT 时，提醒其用完后撤销并轮换。

## 成功标准

实现成功必须同时满足：

- 类型检查和构建通过。
- 账号矩阵任务成功完成。
- 注册流程进入已登录的 ChatGPT 状态。
- 结果产物包含邮箱和生成的 ChatGPT 密码；只有启用 MFA 时才包含 OTP 密钥。
- 日志、提交、聊天中讨论的截图和项目生成文件均不得泄露密钥。

遇到阻塞时，要明确归类为：代码缺陷、OpenAI 页面变化、CapSolver 失败、Microsoft OAuth 失败、IMAP 权限失败或用户提供的凭据无效。
