# 钱包与支付生产 Runbook

## 1. 不变量与告警入口

- 所有点数和金额在接口中使用无符号十进制字符串，在进程和 PostgreSQL 中使用 `BigInt/BIGINT`；禁止 JavaScript `number` 参与财务计算。
- 每个钱包账本事务的分录和必须为零。`LedgerTransaction`、`LedgerEntry` 和充值套餐快照只追加、不更新、不删除；纠错只能新增补偿事务。
- 用户可用与冻结余额不得为负。所有扣减在 PostgreSQL `SERIALIZABLE` 事务中按稳定顺序锁定账户，并最多重试三次。
- 支付回调必须先以原始报文完成微信平台证书序列号选择、RSA-SHA256 签名校验和五分钟时间窗校验，再进行 JSON 解析及 AES-256-GCM 解密。
- `PaymentCallback.transactionId`、订单 `transactionId`、outbox 状态转换和钱包业务键 `payment:<orderId>:credit` 共同保证重复回调不重复入账。

探针：`GET /live` 只表示进程存活；`GET /ready` 检查 PostgreSQL，payment-service 还检查支付平台证书可用性。指标分别从 `GET /metrics` 获取，指标不含用户、订单或交易 ID 标签。

## 2. 发布前检查

```powershell
corepack pnpm --filter @repo/wallet-service test:coverage
corepack pnpm --filter @repo/payment-service test:coverage
corepack pnpm --filter @repo/wallet-service build
corepack pnpm --filter @repo/payment-service build
corepack pnpm --filter @repo/wallet-service exec prisma migrate status
corepack pnpm --filter @repo/payment-service exec prisma migrate status
```

先执行数据库备份和迁移，再滚动发布；必须观察 readiness、`wallet_serializable_retries_total`、`payment_callback_failures_total` 和应用错误率。两个服务镜像均以非 root 用户运行。

## 3. 微信平台证书轮换

1. 从微信支付官方接口获取并核对新平台证书序列号、有效期和公钥指纹。
2. 将证书写入 KMS，使用新引用更新 `WECHAT_PLATFORM_CERTIFICATE_REFS`，保留尚在回调重试窗口内的旧证书引用。
3. 滚动发布 payment-service；确认 `/ready` 为 200，并以微信签名探针验证新旧序列号都可校验。
4. 等待旧证书过期且超过渠道最长回调重试窗口后，再删除旧引用。不得把私钥、APIv3 key 或证书正文写入环境变量、镜像或日志。

商户私钥或 APIv3 key 轮换使用相同的双版本步骤。任何 KMS 读取失败都会阻止进程进入 ready，不得绕过。

## 4. 回调中断

1. 查看 `payment_callback_failures_total`、网关/WAF 原始状态码和 payment-service 日志中的错误代码，严禁记录回调明文或密钥。
2. 若证书未知、签名失败、时间漂移或 GCM tag 失败，先恢复证书、时钟或 KMS，不得手工把订单改为 `PAID`。
3. 回调恢复后运行两分钟以上 PENDING 订单的主动查单恢复。主动查单必须进入与回调完全相同的 `acceptPayment` 事务路径。
4. 核对每个已支付订单恰有一个 `payment.paid.v1` outbox，并检查钱包业务键 `payment:<orderId>:credit` 只有一个账本事务。

## 5. 钱包对账不一致 P0

检测到快照与不可变分录之和不一致时，系统会阻断对应钱包并发送 P0。值班人员应：

1. 冻结受影响钱包的非修复命令，保留数据库、应用与审计日志现场。
2. 用下方只读 SQL 复算分录，不得直接更新 `BalanceSnapshot`、账本事务或分录。
3. 确定根因和补偿方向，创建调整申请；申请人之外的两名授权管理员分别复核。只有第二次有效批准才发布补偿账本事务。
4. 再次执行全量对账，确认差异为零后解除钱包限制，并在事故记录中保存审批人、业务键、trace ID 和复算证据。

## 6. 渠道日对账

每日以 UTC 账单日期运行 `POST /internal/payments/reconciliation/YYYY-MM-DD`。比较订单号、微信交易号、金额和状态：

- `CHANNEL_ONLY`、`PLATFORM_ONLY`、`AMOUNT_MISMATCH` 属于有资金影响的 P0。
- `TRANSACTION_ID_MISMATCH`、`STATUS_MISMATCH` 属于 P1，但必须在下一个结算窗口前关闭。
- 差异写入 `ChannelReconciliation.summary`，金额仅保存十进制字符串；禁止自动修改订单或钱包。

对账一致前不得确认当日渠道结算完成。修复只能通过重新处理已验证回调、主动查单或经双人复核的补偿事务完成。

## 7. 退款重试

退款必须使用授权原因和唯一 `refundNo`。网关请求成功后，钱包使用固定业务键 `refund:<refundId>:wallet` 反向扣除充值点数。失败记录保持 `FAILED` 并可重试；重试必须复用原 refundNo 和钱包业务键，禁止创建第二笔退款。

观察 `payment_refund_backlog`。若渠道已退款而钱包补偿失败，先恢复 wallet-service，再重试同一退款；钱包余额不足时转人工 P0，禁止直接改余额或把退款标为成功。

## 8. 只读账本核验

以下命令必须使用只读数据库账号，并先设置独立的 `FINANCE_READONLY_URL`：

```powershell
psql $env:FINANCE_READONLY_URL -v ON_ERROR_STOP=1 -c 'SELECT "transactionId", SUM("delta") AS total FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM("delta") <> 0;'
psql $env:FINANCE_READONLY_URL -v ON_ERROR_STOP=1 -c 'SELECT a."ownerId", a."kind", s."balance", COALESCE(SUM(e."delta"),0) AS recomputed FROM "WalletAccount" a JOIN "BalanceSnapshot" s ON s."accountId"=a."id" LEFT JOIN "LedgerEntry" e ON e."accountId"=a."id" GROUP BY a."ownerId",a."kind",s."balance" HAVING s."balance"<>COALESCE(SUM(e."delta"),0);'
psql $env:FINANCE_READONLY_URL -v ON_ERROR_STOP=1 -c 'SELECT "businessKey", COUNT(*) FROM "LedgerTransaction" GROUP BY "businessKey" HAVING COUNT(*)>1;'
psql $env:FINANCE_READONLY_URL -v ON_ERROR_STOP=1 -c 'SELECT "transactionId", COUNT(*) FROM "PaymentCallback" GROUP BY "transactionId" HAVING COUNT(*)>1;'
```

所有查询预期返回零行。输出包含用户或订单标识时只保存到受控事故工单，不粘贴到公共聊天。

## 9. 备份、恢复与回滚

- 恢复前暂停写流量，保留渠道回调到耐久队列；同时备份 wallet 与 payment 数据库的同一时间点，并记录 WAL LSN。
- 执行时间点恢复后先以只读模式运行账本全量复算、支付回调唯一性和渠道对账。确认一致后先开放回调/主动查单，再开放退款和普通钱包写入。
- 应用回滚只能回滚到兼容当前数据库 schema 的镜像。数据库迁移默认前向修复，不得删除财务表、触发器、唯一约束或已写入的列。
- 若新版本错误地产生财务事实，停止写入并走补偿事务；不得通过代码回滚删除或覆盖既有账本、订单快照或回调记录。
