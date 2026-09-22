# WS20 故障与恢复演练

日期：2026-09-22  
结论：**NO-GO — 演练入口已交付，恢复目标未被证明**

## 已交付

- `tests/chaos/provider-failures.ps1`：429、5xx、认证、余额不足、超时、重复及乱序回调注入入口。
- `tests/chaos/kill-pods.ps1`：本地 Gateway/Generation/Provider/Redis/RocketMQ 重启和 Kubernetes pod 删除入口。
- `tests/chaos/restore-verification.ps1`：源库与隔离恢复库的 Ledger/Payment/Generation 数量核对。

## 未通过项

- 完整栈未 ready，脚本未在活跃任务上形成端到端证据。
- 未取得 Provider、RocketMQ、Redis、PostgreSQL 故障期间的 bounded retry、circuit、无重复采购和退款证明。
- 无阿里云 RDS/OSS 凭据和隔离恢复环境，未执行 PITR、软删除资产恢复，RPO ≤ 5 分钟、RTO ≤ 60 分钟未证明。
- 无 staging/Kubernetes 发布权限，未执行失败 canary 自动回滚和向后兼容 migration 演练。

不得从组件测试推断灾备门禁通过。
