# WS15 用户端 Web

## 产品范围

WS15 交付面向个人创作者的生产级 Web 端：用户可以发现视频模型、以手机号登录、从能力 Schema 填写参数并获取报价，并在同一账户范围内跟踪任务、素材、点数、订单、发票、消息、工单和安全设置。界面支持 1440×960 桌面端和 390×844 移动端验收断点。

工作台不会把供应商表单写死在浏览器中。字段、约束、默认值和报价请求都来自能力 Schema；未知或不支持的 Schema 关键字会显式拒绝，不会静默降级。

## 页面与主要状态

| 路由                                  | 能力                                       | 关键状态                                                                 |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| /                                     | 产品价值、生成流程和行动入口               | 公开、可键盘跳转主内容                                                   |
| /models、/models/[id]                 | 按生成方式/提供商筛选、模型详情            | 空结果、无效模型、Gateway 不可用                                         |
| /pricing                              | 点数计价说明                               | 公开                                                                     |
| /login                                | 手机号验证码登录                           | 发送中、登录中、字段错误并聚焦、不泄露账号是否存在                       |
| /auth/session/refresh                 | 过期会话刷新跳板                           | 成功返回经严格校验的 returnTo；失败回登录                                |
| /studio                               | 模型/智能路由、Schema 表单、报价和幂等创建 | 加载、Schema 错误、报价过期、会话刷新后同 key 重试、确定失败和结果不确定 |
| /tasks、/tasks/[id]                   | 用户范围任务、进度、取消、重试草稿和结果   | SSE 重连/轮询降级、成功结算、失败退款、无权限/404                        |
| /assets                               | 上传和复用图片/视频                        | 上传中、完成、类型/大小/同源校验失败                                     |
| /wallet、/orders、/invoices           | 点数、账本、订单和发票                     | 空状态、分页、下载授权失败                                               |
| /messages、/tickets                   | 消息、已读、工单创建/回复/评价/反馈        | 空状态、过滤、表单错误、状态冲突                                         |
| /settings/profile、/settings/security | 资料、手机号变更、会话撤销和注销           | 再验证、当前会话保护、撤销后立即失效                                     |
| /help/[[...slug]]                     | 经消毒的帮助中心内容                       | 空内容、不可用                                                           |

## Gateway、会话与 Mock 边界

浏览器只访问同源 Next.js BFF。手机号登录、刷新、实时任务列表/详情/取消/重试及支持类能力由服务端访问 GATEWAY_URL；不使用 NEXT_PUBLIC_GATEWAY_URL，也不把 access/refresh token 暴露给客户端。会话使用加密、HttpOnly、Secure、SameSite=Lax cookie，所有私有数据以服务端 owner 为权限边界。

真实 Gateway 契约不足以支撑工作台或商业流时，应用默认 fail closed，不暴露 demo fixture。只有服务端明确设置以下模式才启用严格类型化、owner-scoped 的持久 Mock：

- USER_WEB_STUDIO_MODE=mock：能力 Schema、报价和创建任务。
- USER_WEB_COMMERCE_MODE=mock：上传、短时签名预览/下载和商业账本。
- USER_WEB_SUPPORT_MODE=mock：测试身份、账户、消息和工单。

Mock 不从请求接受 owner，而从服务端会话派生。持久更改经原子事务完成；同一幂等 key 只创建一个任务。成功链为 RESERVE → QUEUED → SUBMITTING → RUNNING → SUCCEEDED → SETTLED，且只有一笔 SETTLE；失败链为 RESERVE → RUNNING → FAILED → REFUNDED，且只有一笔 RELEASE。重复事件不产生重复财务效果，可用点数、冻结点数与账本守恒。允许取消时在同一事务内唯一释放冻结；重试草稿保留 owner 和原能力 Schema。

SSE 日志按 owner/task 分区。Last-Event-ID 只允许重放当前任务已存在的游标；跨任务、未来 revision 或非法游标会被拒绝。读取与状态推进分离，断线不会消费未送达事件，轮询只读取当前真值。结果对象保存在私有 Mock 对象存储；浏览器只拿到短时签名预览或下载地址。

## 运行时配置与部署

生产环境要求：

- Node 24.15.0（.node-version、package.json engines 和 Docker 基础镜像一致）。
- GATEWAY_URL：服务端 Gateway 基址；生产必须使用 HTTPS。
- USER_WEB_SESSION_ENCRYPTION_KEY：32 字节 canonical base64url（43 字符）。
- USER_WEB_IDENTITY_VERIFY_KEYS_JSON：1–5 个 Ed25519 SPKI 公钥组成的 JSON keyring，格式见 apps/user-web/README.md。
- 反向代理后需要校验上传 Origin 时，将 USER_WEB_PUBLIC_ORIGIN 设为完整 HTTPS 公开 origin。

本地/验收 Mock 还需将相应 mode 明确设为 mock，并为 USER_WEB_COMMERCE_MOCK_SIGNING_KEY、USER_WEB_COMMERCE_IDENTITY_KEY 和 USER_WEB_MOCK_IDENTITY_KEY 提供相互独立的 32 字节 canonical base64url 密钥。禁止在生产使用 E2E 固定密钥或自签名证书。

next.config.ts 生成 standalone 输出并设置 CSP、HSTS、COOP、nosniff、Referrer Policy、Permissions Policy 和拒绝 framing。Dockerfile 使用三阶段 Node Alpine 镜像，运行阶段为非 root 用户 nextjs。GET /health 只回报进程存活；GET /ready 校验 Gateway 与会话密钥配置，失败返回 503 且不泄露密钥。

镜像以仓库根目录为 build context，使用 apps/user-web/Dockerfile.dockerignore 排除 Git、环境文件、依赖、构建缓存、测试报告和浏览器输出；Next 的 outputFileTracingRoot 明确指向仓库根，standalone 目录保留工作区依赖布局。容器内安装与构建禁用 lockfile 写入，生产启动文件为 apps/user-web/server.js。参考验证命令：

    docker build -f apps/user-web/Dockerfile -t ws15-user-web:test .
    docker run --rm -p 3000:3000 -e GATEWAY_URL=https://gateway.internal.example -e USER_WEB_SESSION_ENCRYPTION_KEY=<43-char-base64url> -e USER_WEB_IDENTITY_VERIFY_KEYS_JSON=<json-keyring> ws15-user-web:test
    curl.exe -f http://localhost:3000/health
    curl.exe -f http://localhost:3000/ready

生产容器不得设置任何 USER_WEB_*_MODE=mock，也不得装载 E2E 证书或固定测试密钥。本机验收时 Docker CLI 可用，但 Docker Desktop Linux engine 未运行，npipe 端点不存在，因此本轮无法声称镜像实际 build/run 已通过；Dockerfile 结构、非 root、探针、忽略清单和 tracing root 由单元测试验证。

本工作流的保护范围禁止修改 pnpm-lock.yaml，因此新增的精确版本 E2E devDependencies 尚未进入 user-web lock importer；这项 lock importer 合并由 WS20 集成阶段完成。在此之前 Docker 安装显式使用 lockfile=false，不得将容器中的机械 lock 变更回写仓库。

## 页面状态与恢复矩阵

| 页面族         | Loading                           | Error                                                           | Empty                                | Retry / Recovery                                                                     |
| -------------- | --------------------------------- | --------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| 模型与价格     | 服务器读取期间保留页面框架        | Gateway 不可用显示可理解错误，不回退 demo                       | 筛选无结果给出清除筛选入口           | 重新提交筛选或刷新                                                                   |
| 登录与会话     | 验证码/登录按钮禁用并显示进行态   | 字段错误关联 aria-invalid，焦点回到首个错误；上游错误不枚举账户 | 不适用                               | 过期 access 进入刷新跳板；仅安全 returnTo 返回                                       |
| Studio         | 能力加载和报价按钮有进行态        | Schema/字段/报价/创建错误区分确定失败与结果不确定               | 无可用模型/能力显式不可用            | 报价过期重新报价；SESSION_REFRESH_REQUIRED 刷新后以同 quote 和幂等 key 重试一次      |
| Task           | 初始详情和实时状态有骨架/状态提示 | 无权访问、404、SSE 错误不暴露其他 owner                         | 列表无任务提供工作台入口             | Last-Event-ID 重放；SSE 失败转只读轮询；允许状态可取消或生成 schema-correct 重试草稿 |
| 素材与商业页面 | 上传/请求/下载按钮有进行态        | MIME、大小、Origin、签名、分页和下载错误就地说明                | 素材、账本、订单、发票均有专用空状态 | 上传失败可重选；短签名过期重新请求，不缓存永久 URL                                   |
| 消息与工单     | mutation 期间禁用重复操作         | 状态冲突、字段错误、授权失败显式呈现                            | 无消息/无工单说明下一步              | 重新筛选、重新提交；成功 mutation 后刷新服务端真值                                   |
| 账户与安全     | 再验证/撤销/注销有进行态          | 当前会话和并发撤销规则由服务端强制                              | 无其他会话时仍保留当前会话说明       | 撤销后所有保护页重新鉴权；失败不本地伪造成功                                         |

## 响应式与交互约定

- 桌面端从 48rem 起使用固定侧栏；小于 48rem 时内容改为单列，并将四个主要目的地固定在底部。app shell 预留 5.5rem 与 safe-area，浏览器测试会把主内容最后一个操作滚入视口并证明其底边不超过底部导航顶边。
- 所有页面禁止水平溢出。390×844 截图使用单一真实 viewport，避免 full-page 拼接把 fixed 导航复制到内容中段；桌面关键图保留 full-page。
- Skip link 默认 visibility:hidden 且 pointer-events:none，获得键盘焦点时恢复可见/可操作。报价与创建可用 Tab 和 Enter 完成；表单错误把焦点送到首个无效控件。
- AccessibleDialog 使用 role=dialog 和 aria-modal，打开后聚焦首个操作，Tab/Shift+Tab 在对话框中循环，Escape 关闭，关闭后焦点返回触发器。删除账户、撤销会话、素材删除、发票申请、工单评价/反馈复用这一行为。
- prefers-reduced-motion: reduce 下动画与 transition 验收时长不超过 0.01ms。

## 验证基线

Vitest 显式排除 e2e 目录。Playwright 使用生产 build、本地 HTTPS 反向代理和独立确定性 Mock Gateway，禁止 waitForTimeout。本次验收使用 @playwright/test 1.63.0、@axe-core/playwright 4.13.0 和本机 Chrome 137.0.7117.2。CI 应先运行 corepack pnpm --filter @repo/user-web exec playwright install chromium，再运行 corepack pnpm --filter @repo/user-web e2e。

核心流 E2E 覆盖手机号登录、模型筛选/详情、真实 WebP 上传与恶意 Origin 403、Schema 报价、重复提交幂等、SSE 断线恢复、可解码 MP4 的 loadedmetadata/canplay、成功唯一 SETTLE 和失败唯一 RELEASE。媒体和本地测试证书的生成/许可审计见 apps/user-web/e2e/fixtures/README.md。

Axe 在桌面/移动的首页、登录、Studio、Task、Wallet 和 Tickets 上以 wcag2a、wcag2aa、wcag21a、wcag21aa、wcag22aa 标签验收零违规；同时验证键盘顺序/回车操作、错误聚焦和 aria-invalid、reduced-motion、水平溢出，以及移动端最后一个主内容操作不被底部导航遮挡。

真实浏览器生成的关键验收图位于：

- [桌面首页](../../apps/user-web/output/playwright/acceptance/desktop/home.png)
- [桌面 Studio 报价](../../apps/user-web/output/playwright/acceptance/desktop/studio-quote.png)
- [桌面成功任务](../../apps/user-web/output/playwright/acceptance/desktop/task-success.png)
- [桌面结算钱包](../../apps/user-web/output/playwright/acceptance/desktop/wallet-settled.png)
- [移动首页](../../apps/user-web/output/playwright/acceptance/mobile/home.png)
- [移动 Studio 报价](../../apps/user-web/output/playwright/acceptance/mobile/studio-quote.png)
- [移动任务详情](../../apps/user-web/output/playwright/acceptance/mobile/task-detail.png)
- [移动钱包](../../apps/user-web/output/playwright/acceptance/mobile/wallet.png)
- [移动工单](../../apps/user-web/output/playwright/acceptance/mobile/tickets.png)

验收命令和本轮结果：

| 命令                                                              | 结果                                    |
| ----------------------------------------------------------------- | --------------------------------------- |
| node ../../node_modules/eslint/bin/eslint.js .                    | 通过，0 问题                            |
| node ../../node_modules/typescript/bin/tsc --noEmit               | 通过                                    |
| node ../../node_modules/vitest/vitest.mjs run --environment jsdom | 23 files / 318 tests 通过               |
| node node_modules/next/dist/bin/next build                        | 通过，18/18 静态页面生成                |
| PLAYWRIGHT_CHANNEL=chrome playwright test                         | 3 通过 / 1 跳过：核心流 1，axe 2，41.6s |

## Analytics 事件目录（待接入）

当前交付没有 analytics 事件接收端或埋点实现；下表是建议给 WS17/WS20 的数据契约，不表示事件已经发送，也不声称任何真实转化、留存或成功率。

| 建议事件               | 触发点                 | 允许字段                                        |
| ---------------------- | ---------------------- | ----------------------------------------------- |
| model_filter_applied   | 用户提交模型筛选       | mode、provider、result_count                    |
| model_detail_viewed    | 模型详情成功呈现       | model_id、mode                                  |
| login_outcome          | 登录请求确定结束       | outcome、error_category、duration_bucket        |
| studio_quote_outcome   | 报价确定结束           | model_id、mode、outcome、points_bucket          |
| task_submit_outcome    | 幂等创建确定结束       | task_id、model_id、outcome、retry_after_refresh |
| task_terminal          | 任务进入结算或退款终态 | task_id、terminal_state、duration_bucket        |
| asset_upload_outcome   | 素材上传确定结束       | media_type、size_bucket、outcome                |
| support_ticket_outcome | 工单创建确定结束       | category、outcome                               |

所有事件都必须使用服务端产生的匿名/业务 ID 和枚举值。禁止采集手机号、短信验证码、access/refresh token、cookie、完整原始 prompt、素材内容或签名 URL、支付卡/银行信息、发票抬头税号、工单自由文本及任何密钥。接收端还需定义保留期限、采样、同意/退出机制、地域与删除流程后才能启用。
