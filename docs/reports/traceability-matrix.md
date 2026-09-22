# WS20 需求追踪矩阵

日期：2026-09-22

| 需求域                                  | Owner                   | 验证/证据                                           | 运维证据                         | 结果              |
| --------------------------------------- | ----------------------- | --------------------------------------------------- | -------------------------------- | ----------------- |
| Identity 用户登录、换绑、关户、会话撤销 | Identity/User Web       | Identity tests；商业闭环仅部分聚合验证              | Identity runbook/alerts 已合并   | PARTIAL           |
| IAM MFA、RBAC、数据范围、审计           | IAM/Admin Web           | IAM 组件通过；Admin E2E MFA 超时                    | IAM runbook/alerts 已合并        | NO-GO             |
| Catalog 模型与能力版本                  | Catalog/Admin Web       | workspace test/build；Admin UI E2E 未完成           | Catalog runbook 已合并           | PARTIAL           |
| Routing 报价、margin、模拟与 failover   | Routing/Admin Web       | workspace test/build；Admin UI E2E 未完成           | Routing alerts/runbook 已合并    | PARTIAL           |
| Wallet 双式账本、冻结、结算、退款、调整 | Wallet                  | ledger property + reconciliation PASS               | finance runbook 已合并           | PASS（组件/集成） |
| Payment 回调、退款、对账                | Payment                 | callback integration + channel reconciliation PASS  | payment runbook 已合并           | PASS（组件/集成） |
| Generation 状态机、幂等、SSE            | Generation/User Web     | workspace suite + 用户成功/失败聚合 PASS            | generation alerts/runbook 已合并 | PARTIAL           |
| Provider callback、circuit、购买安全    | Provider Runtime/Mock   | callback + circuit integration PASS                 | chaos 未执行                     | PARTIAL           |
| Edge CORS、身份传播、限流               | Edge Gateway            | rate-limit test PASS；完整 DAST 未执行              | gateway runbook 已合并           | PARTIAL           |
| Asset 上传、结果导入、OSS 私有边界      | Asset                   | workspace suite PASS；OSS/SSRF/恢复未端到端验证     | asset runbook 已合并             | NO-GO             |
| Notification 消息与 DLQ                 | Notification            | workspace suite PASS；RocketMQ 故障未演练           | notification runbook 已合并      | NO-GO             |
| Operations 工单、CMS、任务修复          | Operations/Admin Web    | workspace suite PASS；Admin E2E 未通过              | operations runbook 已合并        | NO-GO             |
| Reporting 投影、导出、可观测性          | Reporting/Observability | workspace suite PASS；耐久和 lag 未验证             | dashboards/alerts 已合并         | PARTIAL           |
| User Web 商业闭环                       | User Web                | 成功结算与失败退款聚合 PASS；完整 Compose UI 未执行 | web runbook 已合并               | PARTIAL           |
| Admin Web 财务/RBAC/MFA                 | Admin Web               | 浏览器 global setup `CHALLENGE_INVALID`             | admin runbook 已合并             | NO-GO             |
| Infrastructure Compose/Terraform/Helm   | Infrastructure          | Compose config PASS；全栈、Terraform、Helm 未通过   | deployment runbooks 已合并       | NO-GO             |
| 性能 200 并发与 24h 耐久                | WS20                    | k6 脚本存在，未运行                                 | 无 staging 时序证据              | NO-GO             |
| 故障、备份恢复、回滚                    | WS20/Infra              | chaos/restore 脚本存在，未运行                      | 无 RPO/RTO/canary 证据           | NO-GO             |
| 安全、秘密、镜像、DAST、隐私            | WS20/Security           | audit 0 High/Critical；其余扫描缺失                 | 无完整扫描归档                   | NO-GO             |
| 真实供应商上线                          | Provider Integration    | 仅 Mock Provider；无真实 conformance                | 无真实凭据/回调/配额证据         | NO-GO             |

追踪规则：任何 `PARTIAL` 不能替代生产门禁，任何 `NO-GO` 都直接阻断生产上线。
