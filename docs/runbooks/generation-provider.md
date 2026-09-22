# Generation / Provider Runtime Runbook

## 1. 范围、负责人和安全边界

本 Runbook 覆盖 `generation-service`、`provider-runtime` 和只用于集成测试的 `mock-provider`。生产值班主责为生成平台 On-call；账务异常由钱包/财务 On-call 联合处理；单供应商故障由 Provider On-call 处理；P0/P1 事件必须通知事故指挥人。

当前仓库没有任何真实供应商协议、字段或密钥。真实适配器只有在获得供应商官方文档、沙箱与生产凭据并通过准入套件后才能上线。不要把 Mock Provider 字段映射到真实供应商。

禁止在日志、告警标签、工单截图或 Runbook 记录中粘贴密钥、完整回调体、用户素材 URL 或原始请求。任务、用户和 `providerTaskId` 可以进入受控结构化日志，但不能成为 Prometheus 标签。

## 2. 启动与健康检查

镜像分别监听默认端口 3000、3001、3002，并以 UID/GID `10001:10001` 非 root 运行。

- `GET /health/live`：只证明进程事件循环可以应答，不检查外部依赖。
- `GET /health/ready`：检查命名依赖，失败返回 503；响应只包含布尔值，不包含 URL、错误文本或凭据。
- `GET /metrics`：Prometheus 文本格式。

Generation 必须配置 `READINESS_DATABASE_URL`、`READINESS_MESSAGE_BUS_URL`、`READINESS_WALLET_URL`、`READINESS_ROUTING_URL`、`READINESS_ASSET_URL`。Provider Runtime 必须配置 `READINESS_DATABASE_URL`、`READINESS_MESSAGE_BUS_URL`、`READINESS_ADAPTER_REGISTRY_URL`。URL 只能使用 HTTP(S)，不得携带用户名或密码。它们应指向集群内受网络策略保护的就绪端点，不是公网供应商地址。探针 URL 只是外部依赖信号；最终 readiness 还必须通过镜像内业务组合自身的数据库、Mock 配置和消息 transport 检查。

Mock Provider 仅允许在本地、CI 或隔离预发布环境启动。`MOCK_PROVIDER_CALLBACK_SECRET` 必须由测试命名空间 Secret 注入；不得写入镜像、Git 或命令历史。还必须配置 `MOCK_PROVIDER_CALLBACK_URL`，指向 Provider Runtime 的实际 UUID 路由 `/callbacks/$MOCK_PROVIDER_ID`。Mock 会把已签名的**原始字节**通过有界超时和最多 `MOCK_PROVIDER_CALLBACK_MAX_ATTEMPTS` 次投递。只有 `callback-lost` 场景故意不投递；没有全局 callback target 时进程拒绝启动，库级测试服务器的 readiness 为 503。

两个服务的默认入口都直接调用镜像内的生产组合工厂，而不是启动仅有探针的进程：

- Generation 工厂构造 Prisma task/provider-event repositories、任务 HTTP controller、冻结参数 dispatch lookup、创建与任务管理服务、provider-event consumer、Repair Job 和 HTTP Outbox transport；需要 `DATABASE_URL`、`ROUTING_API_URL`、`WALLET_API_URL`、`ASSET_API_URL`、`PROVIDER_RUNTIME_API_URL`、`MESSAGE_TRANSPORT_PUBLISH_URL`、`MESSAGE_TRANSPORT_READY_URL`、`GATEWAY_IDENTITY_HMAC_SECRETS` 和 `INTERNAL_SERVICE_AUTH_TOKENS`。
- Provider 工厂构造 Prisma execution/callback/poll/circuit repositories、严格原始字节回调服务、执行/轮询/余额处理器和 HTTP Outbox transport；只装配确定性 Mock Provider，需要 `DATABASE_URL`、`MOCK_PROVIDER_ID`（UUID）、`MOCK_PROVIDER_MODEL_CODE`、`MOCK_PROVIDER_URL`、`MOCK_PROVIDER_CALLBACK_SECRET`、`GENERATION_DISPATCH_API_URL`、`MESSAGE_TRANSPORT_PUBLISH_URL`、`MESSAGE_TRANSPORT_READY_URL` 和 `INTERNAL_SERVICE_AUTH_TOKENS`。`GENERATION_DISPATCH_API_URL` 必须是 Generation 的完整 `http(s)://.../internal/dispatch` 端点，Provider 不拼接路径；lookup 仅在 task ID、capability version 和 parameters snapshot SHA-256 三者同时匹配持久化行时返回冻结 parameters。
- 仓库没有获批 RocketMQ SDK 字段。两个默认工厂内置 transport-neutral HTTP 桥接：`MESSAGE_TRANSPORT_PUBLISH_URL` 是接收冻结 `EventEnvelope` JSON 的**完整发布端点**，`MESSAGE_TRANSPORT_READY_URL` 是完整就绪端点；服务不会拼接或猜测供应商路径。发布请求使用 Outbox deduplication key（缺失时用 event ID）作为 `idempotency-key`，只有 2xx 后才以 `id + publishedAt=null + attempts` 乐观围栏标记已发布；失败只增加 `attempts` 和受限 `lastError`，仍可安全重试。Generation transport 在成功发布后唤醒本 Pod 的 SSE durable catch-up；每个活动 SSE 也以 1 秒有界间隔读取 `TaskTransition`，因此能发现其他副本提交或本地通知丢失的转换。重连仍用 `Last-Event-ID` 精确恢复，正确性不依赖 Pod 内存。

同一个 `/metrics` 实例被强制注入创建、任务管理、provider-event、Repair、执行、轮询和熔断路径。Generation 的 repair gauge 按持久化 open case 的 `kind` 映射到固定三类，财务 gauges 每次 durable scan 都以完整快照刷新（缺失原因/阶段归零）；Provider polling backlog 与 CLOSED/OPEN/HALF_OPEN 熔断数量在 readiness/健康扫描中从 Prisma 完整刷新，不依赖某个 Pod 曾触碰过哪些通道。

挂载面用于部署冒烟：Generation 对外任务面为 `/v1/tasks`、`/v1/tasks/:id`、`/v1/tasks/:id/events` 与 `/v1/tasks/:id[/cancel|/retry]`。网关必须发送 `x-authenticated-user-id`、十位 Unix 秒 `x-gateway-timestamp`、至少 128 bit 随机且每请求唯一的 `x-gateway-request-id` 和十六进制 `x-gateway-signature`。签名正文逐行依次为 `userId`、`timestamp`、`requestId`、`upper(method)`、`pathWithQuery`、`sha256(rawBody)`、`idempotency-key:<value-or-empty>`、`last-event-id:<value-or-empty>`、`x-trace-id:<value-or-empty>`，使用 `GATEWAY_IDENTITY_HMAC_SECRETS` 第一项做 HMAC-SHA256；头名固定小写，缺失值编码为空字符串。服务对最多两把密钥全部执行常量时间比较、允许最多 300 秒时钟偏差，并用 `InboxMessage` 的 `(consumer,messageId)` 唯一键事务性认领 request ID；因此相同正文的不同 nonce 可同时合法执行，同一 nonce 的重放会跨副本拒绝，数据库不可用也 fail closed 为 401。每次认领只清理超过 600 秒的该专用 consumer 记录。裸 user header、改写路径/正文/已签头/用户和重放均返回 401。Generation 内部面为 `/internal/provider-events`、`/internal/repair/run`、`/internal/outbox/publish`、`/internal/dispatch`。Provider 的 `/inspect`、`/cancel`、`/internal/execution/consume`、`/internal/polling/consume`、`/internal/health/run`、`/internal/outbox/publish` 全部要求 `Authorization: Bearer` 使用 `INTERNAL_SERVICE_AUTH_TOKENS` 中任一 token 并对最多两项全部执行常量时间比较；Generation 内部面同样如此。`/callbacks/:providerUuid` 只使用第 3 节的供应商原始字节 HMAC，不能被内部 bearer 替代；health/metrics 无认证但只能暴露布尔状态或低基数指标。

两个复数配置都是以逗号分隔的 Secret Manager/KMS 引用解析结果，第一项用于出站签名/认证，全部项目用于入站验证；只允许 1–2 个互不相同且各至少 32 字节的值，不得出现在镜像、Git、探针响应、日志或命令行。内部 token 必须三阶段滚动：先在所有调用方与接收方部署 `[old,new]`（仍发送 old、开始接受 new），再全部部署 `[new,old]`（改发 new、仍接受 old），确认无旧 token 流量后部署 `[new]`。网关 HMAC 只由网关出站签名：先让 Generation 全部接受 `[old,new]`，再让网关改签 new 并把 Generation 改为 `[new,old]`，至少等待 300 秒验签窗口且确认无 old 后收敛为 `[new]`。单值旧变量 `GATEWAY_IDENTITY_HMAC_SECRET`、`INTERNAL_SERVICE_AUTH_TOKEN` 只用于兼容迁移，不能与对应复数变量同时设置。Generation readiness 会额外以有界请求检查 `PROVIDER_RUNTIME_API_URL/health/ready`，结果键为 `provider_runtime`；失败时不得接收业务流量。

启动前检查：

1. 数据库迁移已在独立作业中成功，且 migration lock 与镜像版本一致。
2. Generation 与 Provider Runtime 使用不同数据库账号，禁止跨库查询。
3. Outbox 发布器和 Inbox 消费器可访问消息总线，消费者组没有被错误复用。
4. KMS/Secret Manager 引用可读，但不要在探针或日志中输出解析后的值。
5. `/health/ready` 连续成功，才允许接收业务流量。

从仓库根目录执行构建（需要 BuildKit；相邻的 `Dockerfile.dockerignore` 会排除宿主机 `node_modules`、`dist`、coverage 和生成物）：

```powershell
docker build -f services/generation-service/Dockerfile -t ws13-generation:verify .
docker build -f services/provider-runtime/Dockerfile -t ws13-provider:verify .
docker build -f providers/mock-provider/Dockerfile -t ws13-mock:verify .
```

生产迁移必须是单独 Job，先由 Secret 注入 `DATABASE_URL`，再从仓库根目录运行；不要把 URL 写进命令或镜像：

```powershell
corepack pnpm --dir services/generation-service exec prisma migrate deploy --config prisma.config.ts
corepack pnpm --dir services/provider-runtime exec prisma migrate deploy --config prisma.config.ts
```

隔离环境启动 Mock（以下值均为示例服务地址，不是真实供应商字段或密钥）：

```powershell
$env:MOCK_PROVIDER_ID='0198f4d4-21c2-7b7d-8a03-08a0da2a51a7'
$env:MOCK_PROVIDER_CALLBACK_URL="http://provider-runtime:3001/callbacks/$env:MOCK_PROVIDER_ID"
$env:MOCK_PROVIDER_CALLBACK_SECRET='<INJECTED_TEST_SECRET>'
docker run --rm -p 3002:3002 --env MOCK_PROVIDER_CALLBACK_URL --env MOCK_PROVIDER_CALLBACK_SECRET ws13-mock:verify
Invoke-WebRequest http://127.0.0.1:3002/health/live
Invoke-WebRequest http://127.0.0.1:3002/health/ready
Invoke-WebRequest http://127.0.0.1:3002/metrics
```

使用 Secret/ConfigMap 生成的 env-file 启动服务，避免把凭据放入命令历史；下列文件名是受控占位符：

两个 env-file 都必须含以下完整 HTTP 桥接端点（示例域名为保留占位符，需映射到已批准的消息桥接服务）：

```text
MESSAGE_TRANSPORT_PUBLISH_URL=http://approved-message-bridge.invalid/v1/envelopes
MESSAGE_TRANSPORT_READY_URL=http://approved-message-bridge.invalid/health/ready
GENERATION_DISPATCH_API_URL=http://generation-service:3000/internal/dispatch
INTERNAL_SERVICE_AUTH_TOKENS=<CURRENT_SECRET>,<PREVIOUS_SECRET_DURING_ROTATION_ONLY>
GATEWAY_IDENTITY_HMAC_SECRETS=<CURRENT_SECRET>,<PREVIOUS_SECRET_DURING_ROTATION_ONLY>
```

桥接服务必须逐字接收 JSON envelope 与 `idempotency-key`，按该键去重后再交给获批 MQ；不得重新生成 message ID、改写正文或把响应正文写入日志。发布与 readiness 请求都携带内部 bearer，但桥接器不得记录该 header。就绪端点必须只返回可用性，不返回凭据。Outbox 的有界批次由受控 Job 使用 bearer 调用 `POST /internal/outbox/publish`；并发调用在单进程合并，跨副本重复 POST 由相同 idempotency key 消除。普通扫描只选择 `publishedAt IS NULL AND availableAt <= now() AND attempts < 10`；第 10 次失败后该 poison row 被隔离，不能继续占用批次，后续行仍可发布。

隔离行只能在确认冻结 envelope 能通过 schema、目标 bridge 幂等键仍有效、没有已发布副本且工单批准后重置。先在事务中锁定精确 ID，再用以下谓词；更新数量必须恰为 1，否则停止：

```sql
BEGIN;
SELECT "id","eventType","deduplicationKey","attempts","lastError","publishedAt" FROM "OutboxEvent" WHERE "id" = :'event_id' FOR UPDATE;
UPDATE "OutboxEvent" SET "attempts" = 0, "lastError" = NULL WHERE "id" = :'event_id' AND "publishedAt" IS NULL AND "attempts" >= 10 AND "lastError" = :'expected_last_error' RETURNING "id","deduplicationKey";
COMMIT;
```

随后仅调用正式 `/internal/outbox/publish`；禁止改写 payload/headers/deduplication key、删除行或手工设置 `publishedAt`。把原错误、审批人、查询结果和 bridge 去重证据附到工单。

```powershell
docker run --rm -p 3000:3000 --env-file <generation-runtime.env> ws13-generation:verify
docker run --rm -p 3001:3001 --env-file <provider-runtime.env> ws13-provider:verify
Invoke-WebRequest http://127.0.0.1:3000/health/live
Invoke-WebRequest http://127.0.0.1:3000/health/ready
Invoke-WebRequest http://127.0.0.1:3001/health/live
Invoke-WebRequest http://127.0.0.1:3001/health/ready
```

默认镜像会调用上述具体工厂和内置 HTTP transport。缺少任一 transport URL 时启动立即失败；桥接 ready 非 2xx、超时或网络失败时 `business_runtime=false` 且 `/health/ready` 返回 503。只有数据库、业务依赖、Mock 配置和消息桥接同时成功，Pod 才能加入流量。

## 3. 回调验签、密钥轮换与回放

回调入口必须保留 HTTP 请求的原始字节。先把未解析的原始字节和原始头交给适配器验签，验签成功后才允许 JSON 解析与规范化。对 body 做重新序列化、字符集转换、字段排序或换行归一化都会改变签名输入，禁止用解析后的对象验签。

正常处理顺序：

1. 根据受控路由中的 provider ID 解析适配器；不能相信回调 body 自报的供应商身份。
2. 使用当前活动密钥验证原始字节；失败返回 401，不写 Inbox、执行状态或 Outbox。
3. 验证规范化 payload、`providerEventId`、`providerTaskId` 和单调 `sequence`。
4. 在一个数据库事务中写唯一 Callback Inbox、执行状态和 Outbox。
5. 重复 event ID 返回幂等结果；低序列、状态回退和终态后的事件只记录受限诊断，不发布第二个领域事件。

密钥轮换：

1. 先在 KMS/Secret Manager 写入新版本，保留旧版本；不把密钥值写入配置表。
2. 适配器进入短暂双版本验证窗口：只签发/配置新版本，但接受新旧两版。窗口长度必须覆盖供应商的最大回调重试周期。
3. 用脱敏的已签名测试样本验证新版本，观察 `provider_errors_total{error_class="AUTH"}` 和 401 比例。
4. 确认旧版本在窗口内无新流量后撤销旧版本并记录审计事件。
5. 如果供应商不支持安全双版本轮换，先暂停该通道并排空回调，再切换；不得猜测其轮换协议。

回放回调时必须使用受控存储中的原始字节、原始签名头和原始 provider event ID，走同一验签与 Inbox 去重路径。禁止修改 payload 后重新签名，禁止直接更新执行状态。若原始签名已过期或密钥版本不可用，转人工对账，不绕过验签。

## 4. 重试、回调丢失与轮询

- 429 按有效 `Retry-After` 或确定性退避重试；5xx、网络错误和超时按有限指数退避重试，最长退避 300 秒。
- 400、401、403 和确定性业务拒绝不盲重试。401/403 触发认证故障处理。
- Create 超时或网络中断可能是“已受理但响应丢失”，必须进入 `AMBIGUOUS`/`RECONCILE`，使用同一 task ID 幂等键查询；不能再次采购，也不能切换供应商。
- Callback 丢失时，在回调期限到达后消费 `provider.execution-poll-due.v1`。默认轮询间隔 30 秒；每次 poll 带递增 poll number、执行身份和 `routeEpoch`。终态停止轮询。
- 查询返回 SUCCEEDED 却没有结果 URL 时按歧义处理，不能伪造成功或直接结算。

## 5. 熔断阈值和恢复

熔断键为受控的 provider/model 组合，不能使用用户输入。默认滚动窗口 60 秒；窗口内至少 10 个 qualifying failures 且失败率大于等于 50% 时打开 60 秒。限流、不可用、超时、网络和协议错误属于 qualifying failure。

认证失败立即打开并产生 P1 健康事件；余额为零立即打开并产生 P2 健康事件。打开期间拒绝新执行，不把请求排到另一个供应商，除非 Generation 的安全切换条件全部满足。

60 秒后只允许一个持有 lease/token 的半开探针：成功则关闭并清空窗口，失败则再次打开 60 秒。半开探针 lease 默认 60 秒；Pod 崩溃后只有 lease 过期才能取得新探针。禁止管理员直接把数据库状态改为 CLOSED；应先修复认证、余额或服务故障，再让探针证明恢复。

关闭条件：连续一个完整观察窗口内无认证/余额告警，半开探针成功，Provider 失败率恢复到阈值以下，且积压开始下降。

## 6. 死信、重复消息与安全重放

任何消息重放前执行以下检查：

1. 保存消息 ID、消费者名、payload SHA-256、trace/correlation ID、原始失败码和首次/最后失败时间。
2. 检查 Inbox 是否 COMPLETE；如果已完成，关闭死信，不重放。
3. 检查同一消息 ID 的 payload hash 是否一致；冲突视为安全事件，不重放。
4. 检查对应 Outbox 是否已发布、provider execution/attempt 是否已有持久结果、钱包业务键是否已有不可变分录。
5. 若 create 的受理或计费状态未知，禁止重放、退款和故障切换，转第 7 节。
6. 可重放时使用原消息 ID、业务幂等键和执行身份进入正式消费者；不得调用内部 repository 绕过 Inbox。
7. ACK 只在领域状态和后续 Outbox 同事务提交后发送。失败继续 retry；超过策略上限回到死信，不无限循环。

死信负责人为对应领域 On-call；涉及冻结、结算或释放时必须由财务 On-call 复核。关闭条件是 Inbox/Outbox/领域状态一致、没有新增采购或重复账务效果，并附上重放审计证据。

消息运维命令只能通过平台批准的 RocketMQ 管理包装器执行。下面是 **transport-neutral 操作占位符**，不是 RocketMQ CLI，也没有虚构供应商 flag；平台接入方必须把四个动词映射到其已批准工具，并把 `<consumer-alias>` / `<message-id>` 换成 CMDB 中的受控别名：

```text
<APPROVED_MQ_ADMIN_WRAPPER> pause-consumer <consumer-alias>
<APPROVED_MQ_ADMIN_WRAPPER> inspect-dlq <consumer-alias> <message-id>
<APPROVED_MQ_ADMIN_WRAPPER> replay-dlq-idempotent <consumer-alias> <message-id>
<APPROVED_MQ_ADMIN_WRAPPER> resume-consumer <consumer-alias>
```

重放前后都查询 Inbox 的 `(consumer,messageId,payloadSha256)` 和 Outbox deduplication key；包装器必须保持原消息 ID/正文，不能改写后再投递。任何歧义受理或缺少 `providerTaskId` 的消息禁止运行 `replay-dlq-idempotent`。

在对应服务数据库上使用只读账号执行以下仓库核查；`DATABASE_URL` 必须来自临时 Secret 注入，命令中的值是审计工单提供的受控标识。先查 Generation 数据库，再按消息所属服务查 Provider 数据库：

```powershell
psql "$env:DATABASE_URL" -v consumer='<consumer-name>' -v message_id='<message-id>' -c 'SELECT "consumer","messageId","payloadSha256","processedAt","lastError" FROM "InboxMessage" WHERE "consumer"=:''consumer'' AND "messageId"=:''message_id'';'
psql "$env:DATABASE_URL" -v dedupe='<deduplication-key>' -c 'SELECT "eventType","deduplicationKey","publishedAt","attempts","lastError" FROM "OutboxEvent" WHERE "deduplicationKey"=:''dedupe'';'
```

只读结果必须满足：payload hash 与 DLQ 原文一致；没有 hash 冲突；已完成 Inbox 不再投递；未完成 Inbox 的 lease 已过期或由当前受控消费者持有；已有已发布 Outbox/钱包业务键时不得再次制造领域效果；execution 身份与 `routeEpoch` 未改变；不存在歧义受理或缺失 `providerTaskId`。实际重放仍只能调用正式消费者入口，由 `PrismaProviderEventRepository` / `PrismaPollRepository` 的 claim、版本和 Inbox 幂等逻辑提交；禁止用 SQL 修改 `processedAt`、删除 Inbox 或直接插入 Outbox。

## 7. 歧义受理与缺失 providerTaskId

以下情况一律建立 `TaskRepairCase` 并暂停自动动作：create 超时、受理与计费查询为 UNKNOWN、Provider Runtime 状态 `AMBIGUOUS`、本地事实与供应商事实矛盾、或任务缺少完整 provider execution 身份。

`/inspect` 只回报本地 durable execution/attempt 能证明的事实：匹配同一 `providerTaskId` 的 CREATE attempt 已进入 `ACCEPTED/RUNNING/SUCCEEDED` 才能回报 `acceptance=ACCEPTED`；当前 schema 没有独立计费凭证，因此 `billing=UNKNOWN`。特别是 `FAILED/CANCELED` 不得凭终态猜测已计费或未计费。没有同时可证明的未受理和未计费事实时，禁止返回 `UNACCEPTED/UNBILLED`，安全切换保持人工审批。

特别是没有 `providerTaskId` 时，不得用“查询不到”推断未受理。值班步骤：

1. 冻结当前 task/version/sagaVersion 与 `routeEpoch` 证据，停止新 create。
2. 用 task ID 幂等键、请求时间窗、脱敏请求摘要和供应商审计渠道定位受理记录。
3. 明确得到“UNACCEPTED 且 UNBILLED”或可验证终态前，不退款、不重试、不切换供应商。
4. 若确认成功，先验证结果 URL，再走资产转存和结算；若确认失败且未计费，走全额释放；若仍不确定，保持 case OPEN 并升级 Provider/财务负责人。

关闭条件是供应商受理、计费与终态三者都有可审计证据，平台状态及钱包效果已通过幂等业务键收敛。

## 8. 卡住任务、状态期限与 lease

Repair Job 每分钟扫描一次，默认批量 100（最大 1000）。默认 stale 期限：RESERVED 60 秒；QUEUED/SUBMITTING/SUCCEEDED/FAILED/CANCELED/EXPIRED 120 秒；RUNNING 900 秒。调整期限必须有变更记录，并同时检查供应商 SLA 和队列延迟。

Repair 先用 Inbox 风格的 claim/lease 取得所有权；每次外部查询、写入和财务动作前续租。版本、Saga 版本或 lease token 不匹配时立即停止，由新持有者继续。不要通过延长 lease 隐藏无进展任务。

处理顺序：验证 execution identity 与 `routeEpoch`；检查 provider 受理/计费；重放确定终态到 Provider Events Consumer；收敛持久化的财务 disposition；只在事实明确时自动修复。身份缺失、事实矛盾或财务 disposition 不完整都建立 operator case。

## 9. 安全故障切换

自动切换必须同时满足：

- 路由快照明确授权切换；任务仍为 SUBMITTING，尚无受理事实且 provider state rank 为 0；没有已确定财务 disposition。
- 原 provider execution 身份完整，并由 Provider Runtime 明确确认 `UNACCEPTED` 和 `UNBILLED`；UNKNOWN/AMBIGUOUS 不满足。
- 备用 provider 不同于原 provider，备用模型的 capability version 与任务冻结版本完全相同。
- 备用销售点数不超过用户确认的 quoted points；不允许后台临时提价。
- 切换与候选信息写审计 case；任务/Outbox 同事务重排队。

每次安全切换把 `routeEpoch` 原子加一，清空旧 `providerTaskId`/execution ID，新的 queued event 带新 epoch、原 execution ID 与授权证据。消费者必须拒绝旧 epoch 回调/轮询结果。不得为了“加快恢复”手工回退 epoch 或复用旧 execution。

## 10. 财务收敛

- Provider 失败：先持久化 FAILED 和 `PROVIDER_FAILED_FULL_RELEASE`，再用唯一业务键全额释放 quoted points，最后标记 REFUNDED。供应商失败成本由平台承担。
- 受理前取消：全额释放。
- 受理后取消：只有供应商实现且确认取消时才执行任务保存的取消规则；AMBIGUOUS 进入人工，不承诺全额退款。
- 成功：先将供应商结果转存为 durable private asset；收到幂等 `asset.imported` 后，结算实际点数并释放 quote 差额，最后 SETTLED。资产未持久化不得结算。
- 所有 settle/release 都使用不可变账本命令和唯一业务键。不要直接更新余额，也不要删除原分录。

财务 case 关闭条件：任务终态、Saga disposition、钱包业务键、冻结余额与资产状态一致；失败全额释放或成功结算/差额释放已在账本可重建验证中通过。

## 11. Mock Provider 故障演练

请求头 `x-mock-scenario` 只允许以下确定性场景：

| 场景                    | 预期                                               |
| ----------------------- | -------------------------------------------------- |
| `success`               | ACCEPTED -> RUNNING -> SUCCEEDED；结果为 mock URL  |
| `failed`                | ACCEPTED -> RUNNING -> FAILED；Generation 全额释放 |
| `timeout`               | create 超出客户端期限；按歧义受理对账，禁止盲重建  |
| `rate-limit`            | 429 与确定性 Retry-After；有限重试                 |
| `server-error`          | 503；有限退避后死信/对账                           |
| `callback-lost`         | 不发送回调；期限后轮询收敛                         |
| `callback-duplicate`    | 相同事件重复；只产生一次领域效果                   |
| `callback-out-of-order` | 高 sequence 先到；低 sequence 被忽略，终态不回退   |

同一 idempotency key 和相同请求必须返回同一 provider task ID；同 key 不同请求必须 409。Mock Provider 不是生产供应商，`/balance` 的 `MOCK_CREDITS` 不得进入真实成本或余额报表。

## 12. 指标、查询和告警

核心指标及示例 PromQL：

- 状态进入量：`sum(rate(generation_tasks_total[5m])) by (status)`。
- 迁移失败：`sum(rate(generation_transition_failures_total[5m])) by (from_status,to_status,reason)`。
- 平均排队年龄：`rate(generation_queue_age_seconds_sum[5m]) / rate(generation_queue_age_seconds_count[5m])`。
- Repair case（每副本均读取相同持久化快照，禁止求和重复计算）：`max(generation_repair_cases) by (reason)`。
- 财务 Saga 最老滞后：`max(generation_financial_saga_lag_seconds) by (phase)`。
- Provider 平均延迟：`sum(rate(provider_request_duration_seconds_sum[5m])) by (operation,outcome) / sum(rate(provider_request_duration_seconds_count[5m])) by (operation,outcome)`。
- Provider 错误：`sum(rate(provider_errors_total[5m])) by (operation,error_class)`。
- 打开熔断通道数：`max(provider_circuit_state{state="OPEN"}) > 0`（持久化聚合快照；只导出固定 state，不导出 provider/model 标签）。
- 轮询积压（副本间取最大值，禁止相加）：`max(provider_polling_backlog)`。

这些指标只使用固定枚举标签；禁止新增 task ID、user ID、providerTaskId、execution ID、URL、异常消息等标签。

| 告警                           | 等级 | 负责人                  | 触发建议                     | 关闭条件                               |
| ------------------------------ | ---- | ----------------------- | ---------------------------- | -------------------------------------- |
| 钱包效果重复、冻结与终态不一致 | P0   | 财务 On-call + 事故指挥 | 任意一条                     | 停止影响、账本差异为零、重复路径关闭   |
| 核心队列/Outbox 无进展         | P1   | 生成平台 On-call        | 10 分钟无消费且 backlog 增长 | 消费恢复、无永久卡住、死信已分类       |
| 认证失败熔断                   | P1   | Provider On-call        | auth-failed health event     | 凭据安全轮换、半开成功、无新增 401/403 |
| 单供应商熔断/余额为零          | P2   | Provider 运营           | OPEN 或 zero-balance event   | 余额/故障修复、半开成功、失败率恢复    |
| Repair case 或财务 lag 增长    | P2   | 生成平台 + 财务         | 连续两个扫描周期增长         | case 已分派、自动/人工收敛、lag 回落   |
| 容量与轮询 backlog 趋势        | P3   | 平台 SRE                | 超过容量基线                 | 扩容或限速完成，backlog 稳定下降       |

## 13. 发布、迁移和回滚

发布：

1. 在空库和上一版本快照分别验证 migration；数据库迁移必须向前兼容，先加列/表/索引，后续版本才能移除旧语义。
2. 构建一次镜像并晋级同一 digest；完成测试、镜像扫描和签名。
3. 先部署 Provider Runtime，再部署 Generation；灰度流量下观察 readiness、Inbox/Outbox、熔断、队列年龄、财务 lag 和错误率。
4. 用全部 Mock 场景做预发布冒烟，确认重复/乱序、歧义、全额释放和安全切换边界。
5. 一个完整回调/轮询/Repair 周期稳定后再全量。

回滚：

1. 暂停新任务受理，不停止 Outbox 发布或幂等消费者；记录回滚时间和镜像 digest。
2. 将应用镜像回滚到上一已验证 digest。不得执行破坏性向下迁移，不删除新列/表；旧应用必须能忽略新字段。
3. 如果新版本已写入旧版本不理解的状态或事件，保持新消费者运行到积压排空，或部署兼容修复；不能靠删消息回滚。
4. 验证 `/health/ready`、消息 lag、Inbox/Outbox、熔断和财务不变量；对回滚窗口内所有歧义任务运行 Repair。
5. 关闭条件：任务受理恢复、无新增死信/歧义、财务差异为零、回滚原因已形成后续修复项。

若迁移包含非向前兼容变更，禁止自动回滚应用；立即升级 P1/P0，按数据库恢复与兼容修复流程处理。

Digest 回滚示例（资源名和容器名必须从已批准部署清单选择）：

```powershell
kubectl -n <namespace> set image deployment/<generation-deployment> <generation-container>=<registry>/<generation-image>@sha256:<verified-previous-digest>
kubectl -n <namespace> set image deployment/<provider-deployment> <provider-container>=<registry>/<provider-image>@sha256:<verified-previous-digest>
kubectl -n <namespace> rollout status deployment/<generation-deployment>
kubectl -n <namespace> rollout status deployment/<provider-deployment>
```

这里的尖括号是必须替换的受控占位符；不得把 tag 当作回滚证据。回滚应用时保持数据库向前兼容，不执行 `migrate reset`、down migration 或删列。
