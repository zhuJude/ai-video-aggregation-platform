# Edge Gateway Runbook

## 服务边界

`edge-gateway` 是用户 Web 与管理后台的唯一 API 入口。它验证两个独立令牌域、实施限流和幂等策略、签发短时内部主体断言、聚合 BFF 数据并代理任务 SSE。Gateway 不保存领域事实，也不访问领域数据库。

## 启动与配置

生产进程使用 `node services/edge-gateway/dist/src/main.js`，容器以 UID/GID `10001` 非 root 运行。必需配置全部通过 ACK Secret/KMS 注入，禁止写入镜像或日志：

- `CORS_ALLOWED_ORIGINS`：逗号分隔的精确 HTTPS Origin。
- `TRUST_PROXY_CIDRS`：仅列出实际 WAF/ALB 出口 CIDR；禁止配置为任意代理。
- `REDIS_URL`：Tair/Redis TLS 连接地址。
- `USER_JWT_PUBLIC_KEYS`、`ADMIN_JWT_PUBLIC_KEYS`：分别固定 identity-service 与 iam-service 的公钥集。
- `GATEWAY_SIGNING_PRIVATE_KEY`：Gateway 内部主体断言签名密钥的 KMS 注入值。
- `SERVICE_DNS_NAMES`：所有必需内部服务 DNS 名称。
- `HOST`（默认 `0.0.0.0`）与 `PORT`（默认 `3000`）。

启动后验证：

```powershell
Invoke-WebRequest http://127.0.0.1:3000/health/live
Invoke-WebRequest http://127.0.0.1:3000/health/ready
Invoke-WebRequest http://127.0.0.1:3000/metrics
Invoke-WebRequest http://127.0.0.1:3000/openapi.json
```

`/health/ready` 只有在 Redis、签名密钥和全部必需服务 DNS 正常时返回 200。普通 JSON 请求体上限为 1 MiB；大文件必须通过受限 OSS 直传。

## 关键指标与告警

- `gateway_http_requests_total`、`gateway_http_request_duration_seconds_*`：按规范化路由、方法和状态码类别聚合。
- `gateway_auth_denials_total`：JWT issuer/audience、过期、未知 `kid` 或权限拒绝。
- `gateway_rate_limit_rejections_total`：边缘限流拒绝。
- `gateway_circuit_open_total`、`gateway_upstream_timeouts_total`：内部依赖异常。
- `gateway_active_sse_streams`：活跃 SSE 连接；不得带用户 ID、任务 ID 等高基数标签。

P1：全站认证失败、Redis 导致敏感写入不可用、核心内部服务熔断。P2：单一服务熔断、SSE 接近容量、目录读取进入 fail-open。告警恢复条件是连续 15 分钟错误率、延迟和连接数回到发布前基线。

## 签名密钥轮换

1. 在 KMS 创建新版本并保留旧公钥；为新密钥分配新 `kid`。
2. identity/iam 先发布同时包含新旧公钥的 JWKS，再让签发端使用新 `kid`。
3. 更新 Gateway 公钥集，确认 `/health/ready` 为 200，并验证 user token 不能访问 admin 路由。
4. Gateway 内部签名密钥轮换时，内部服务先信任新旧 Gateway 公钥，再切换 Gateway 签名 `kid`。
5. 等待最长令牌 TTL 加时钟容差后移除旧公钥；保留审计记录和回滚版本。

未知 `kid`、`alg=none`、错误 issuer/audience、缺少 `sid`、管理员缺少权限或数据范围时均拒绝，不临时放宽验证。

## Redis/Tair 故障

短信、任务、支付、退款和点数调整必须 fail-closed，返回稳定的可重试错误；目录只读请求允许 fail-open，并增加降级指标。不得改为进程内限流或跳过幂等冲突检查，因为多 Pod 下会产生重复效果。

处置顺序：确认 Tair 主备/连接数/TLS；检查 Gateway readiness；暂停高风险入口或保持自动 fail-closed；恢复后验证滑动窗口 Lua、同键同请求重放和同键不同请求 409，再解除告警。

## 上游熔断与超时

普通内部请求连接超时 500 ms、响应头超时 2 秒。幂等读取最多重试一次；写请求不自动重试。检查对应服务 readiness、DNS、网络策略和延迟。半开恢复前不要手动绕过熔断；钱包、支付和生成命令失败必须作为硬失败返回。

## SSE 饱和或断线

每用户最多五条任务事件流，15 秒心跳，空闲两分钟后发送重连指令并关闭。确认 ALB/WAF 已禁用 SSE 响应缓冲和缓存，空闲超时高于心跳周期，并透传 `Last-Event-ID`。连接数不下降时抓取 Pod 连接指标，验证客户端断开会 abort 上游、清除 heartbeat/idle timer 并释放连接槽；必要时滚动单个异常 Pod。

## WAF/ALB 代理头

只把实际 WAF/ALB CIDR 配入 `TRUST_PROXY_CIDRS`。变更后分别从受信和非受信来源验证 `X-Forwarded-For`；非受信来源不得影响客户端 IP。WAF/ALB 必须覆盖外部传入的转发头，不得追加未经清洗的值。CORS 使用精确 Origin 列表，不使用通配符和凭据组合。

## 回滚

1. 停止扩大发布，记录镜像 digest、Trace ID 和触发指标。
2. 将 Deployment 回滚到上一已签名镜像；本服务无数据库迁移。
3. 保持新旧 JWT/JWKS 密钥重叠，禁止因回滚删除仍被令牌引用的公钥。
4. 验证 live/ready、用户与管理员 audience 隔离、Redis fail-closed、幂等冲突和 SSE 断线清理。
5. 观察 15 分钟并确认错误率、p95、熔断和活跃 SSE 恢复后关闭事件。
