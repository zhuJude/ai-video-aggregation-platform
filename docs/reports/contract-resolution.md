# WS20 契约请求处理与 API 冻结报告

- 审查日期：2026-09-22
- 请求目录：`docs/contract-change-requests/`
- 请求清单：空（目录不存在或没有文件）
- 接受请求：0
- 拒绝请求：0
- 未处理请求：0

## 冻结决定

集成基线中的 v1 HTTP/事件契约保持不变。本任务没有重命名、删除或改变任何既有 v1 字段的含义，也没有引入需要双读的新 v2 版本。后续变更必须遵守：

1. v1 只能增加可选字段；不能删除、重命名或收紧既有字段。
2. 不兼容变更必须发布新版本，消费者在迁移期同时兼容旧版本。
3. 事件必须包含 UUIDv7 事件/关联标识、非空类型和生产者、正整数版本、UTC `Z` 时间及 trace ID。
4. 点数和最小货币单位必须使用十进制字符串，不得使用浮点数；业务 ID 必须使用 UUIDv7。
5. 事件类型的 `.vN` 后缀必须与 envelope 的 `version` 一致。

## 冻结证据

`tests/e2e/contracts.spec.ts` 按文件名排序加载 `tests/e2e/fixtures/events/*.json`，并验证：

- 统一事件 envelope、事件类型及版本一致性；
- UUIDv7、UTC 时间、点数和金额字符串规则；
- Identity、Wallet、Generation、Payment 四类代表性生产者 fixture 能被共享契约消费者解析。

首次红灯证据：fixture 目录缺失时，目标测试以 `ENOENT` 失败。补齐冻结 fixture 后目标测试通过。由于没有变更请求，本任务未修改 `packages/contracts/**` 或任何生产者/消费者实现。

## 结论

请求盘点完整，未发现待处理请求；既有 API/事件 v1 契约已冻结。Task 2 状态：**PASS**。
