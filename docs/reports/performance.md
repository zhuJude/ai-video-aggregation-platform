# WS20 性能与耐久门禁

日期：2026-09-22  
结论：**NO-GO — 未取得可采信的运行证据**

## 已交付工作负载

- `tests/load/platform.js`：10,000 次注册账户工作量、200 VU、普通 API p95 < 500 ms、错误率 < 0.5%。
- `tests/load/task-workers.js`：200 并发异步任务、任务接受 p95 < 2 s、错误率 < 0.5%。

## 未通过项

- 当前主机无 `k6`，完整栈也未通过健康门禁，故没有执行可采信的 200 并发结果。
- 无 staging 集群，未验证 KEDA、HPA、Auto Mode 扩缩容及 in-flight task 保护。
- 未运行 24 小时耐久；heap、handle、DB connection、queue lag、stuck task 和账本总量没有 24 小时证据。
- 未获得“钱包差异为零”的压测后数据库核对证据。

任何后续运行必须保留原始 k6 JSON/summary、集群副本数时间序列和压测前后账本核对结果；本报告不把脚本存在等同于容量通过。
