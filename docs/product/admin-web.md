# 管理后台 Web

`apps/admin-web` 是面向内部运营、财务与安全管理员的 Next.js 控制台。所有受保护页面要求已签名管理员会话；登录必须完成密码挑战和 TOTP。后端响应按精确契约解析，未知字段、越权数据范围和原始密钥均失败关闭。

## 路由目录

| 路由 | 用途 | 读取权限 |
| --- | --- | --- |
| `/login` | 密码挑战、TOTP、多因素失败与锁定提示 | 公共入口 |
| `/overview` | 运营、任务、财务、供应商风险总览 | `overview:read` |
| `/users` | 用户检索、精确手机号查询和导出 | `users:read` |
| `/users/[id]` | 账号、任务、钱包、订单、工单、审计详情 | `users:read` |
| `/providers` | 供应商目录与元数据创建 | `providers:read` |
| `/providers/[id]` | 健康、接口、凭证掩码、维护窗口与操作 | `providers:read` |
| `/models` | 模型及能力版本目录 | `models:read` |
| `/models/[id]/capabilities` | JSON Schema/UI Schema 编辑、校验、发布、回滚 | `models:read` |
| `/pricing` | 定价规则草稿、影响预览、发布与回滚 | `pricing:read` |
| `/routing` | 路由策略、候选模拟、发布与回滚 | `routing:read` |
| `/tasks` | 任务、队列状态、暂停/恢复与优先级 | `tasks:read` |
| `/tasks/[id]` | 任务时间线、脱敏原始报文、重试/切换/取消/修复 | `tasks:read` |
| `/finance` | 跳转到财务订单 | `finance:read` |
| `/finance/orders` | 支付订单、回调、退款和异常处理 | `finance:read` |
| `/finance/reconciliation` | 渠道对账、补偿申请和双人审批 | `finance:read` |
| `/finance/ledger` | 不可变复式账本只读查询 | `finance:read` |
| `/finance/invoices` | 发票审核、签发和拒绝 | `finance:read` |
| `/runbooks/wallet-payment` | 钱包/支付/对账处置手册 | 已登录管理员 |
| `/content` | 公告草稿、校验、发布、排序、下架、回滚 | `content:read` |
| `/tickets` | 工单公开回复、内部备注和状态流转 | `tickets:read` |
| `/iam` | 管理员、角色、权限和数据范围 | `iam:read` |
| `/audit` | 审计检索和签名导出 | `audit:read` |
| `/system` | 功能开关、运行配置和死信重放 | `system:read` |

## 权限键

`*` 仅供超级管理员。其余权限按域分组：

- 审计：`audit:read`、`audit:export`。
- 内容：`content:read`、`content:write`、`content:validate`、`content:publish`、`content:reorder`、`content:retire`、`content:rollback`。
- 财务：`finance:read`、`finance:refund-create`、`finance:refund-retry`、`finance:order-close`、`finance:reconciliation-repair`、`finance:reconciliation-approve`、`finance:invoice-review`、`finance:invoice-issue`、`finance:invoice-reject`。
- IAM：`iam:read`、`iam:admin-write`、`iam:role-write`、`iam:role-delete`。
- 模型：`models:read`、`models:write`、`models:publish`、`models:rollback`。
- 总览：`overview:read`。
- 定价：`pricing:read`、`pricing:write`、`pricing:publish`、`pricing:rollback`。
- 凭证：`credentials:read`、`credentials:rotate`、`credentials:disable`。
- 供应商：`providers:read`、`providers:write`、`providers:probe`、`providers:enable`、`providers:disable`、`providers:circuit-reset`。
- 路由：`routing:read`、`routing:write`、`routing:simulate`、`routing:publish`、`routing:rollback`。
- 系统：`system:read`、`system:config-write`、`system:config-publish`、`system:config-rollback`、`system:dlq-redrive`。
- 任务：`tasks:read`、`tasks:raw-read`、`tasks:retry`、`tasks:switch`、`tasks:cancel`、`tasks:refund`、`tasks:repair`、`tasks:queue-pause`、`tasks:queue-resume`、`tasks:priority-write`。
- 工单：`tickets:read`、`tickets:public-reply`、`tickets:internal-note`、`tickets:status-write`。
- 用户与钱包：`users:read`、`users:phone-exact`、`users:export`、`users:refresh`、`users:status`、`wallet:adjust`。

数据范围同时约束权限：`ALL` 为全部，`OWN` 仅本人负责，`ASSIGNED` 仅已分配资源。定价、路由和全局任务队列属于跨租户配置，其写入、发布、回滚、暂停、恢复与限额调整仅允许 `ALL` 数据范围；`OWN`/`ASSIGNED` 会隐藏对应按钮，服务端也会独立拒绝。菜单隐藏不替代服务端校验；直接访问无权限路由仍会失败关闭。

## 高风险确认

所有写操作绑定 UUIDv7 幂等键、权威版本和操作原因。发布/回滚还绑定未过期的权威预检 token、来源版本、目标版本、差异摘要和显式复选确认；回滚提交前必须重新读取当前版本并获取新预检，不接受浏览器携带的旧授权。成功响应按操作类型精确校验审计记录、请求、幂等键、版本、目标和结果状态，未知字段或通用 `{ok:true}` 回执失败关闭。供应商密钥只能通过 KMS 引用和专用轮换操作处理，页面不得回显原文。点数调整和对账补偿要求独立复核人；申请人及已审批人不能自批，历史账本不能直接编辑。最后一个超级管理员不能停用或删除。重复发布、过期预检、版本冲突和权限不足均不展示可执行入口，服务端也再次拒绝。

## 页面状态约定

- Loading：登录提交、按需读取原始报文、模拟与写操作期间禁用重复提交并显示进度。
- Empty：目录返回空集合时显示明确“暂无/无此类”说明，不合成示例数据。
- Error：上游拒绝、超时、畸形响应或路由权限不足进入就地 alert 或错误边界；不回退到缓存猜测值。
- Partial：权威响应声明缺失字段时显示 `partialFields`，缺失值不补零。
- Stale/conflict：乐观锁版本变化要求刷新后重试；旧预检不能复用。
- Sensitive：手机号、外部任务 ID、管理员身份和凭证均掩码；原始报文按需读取后再次递归脱敏。

## 验收与运行

以下命令均从 `apps/admin-web` 目录运行。单元和构建：

```sh
cd apps/admin-web
pnpm install --lockfile=false --ignore-workspace
pnpm --config.ignore-workspace=true test
pnpm --config.ignore-workspace=true build
```

E2E 的 Playwright、axe 和自签名证书依赖均在应用 `package.json` 中精确固定，安装不创建或修改任何 lockfile；fixture 是严格校验 method、身份/追踪/幂等 header 与 mutation body 的测试专用 HTTPS 服务，未知请求返回 500，不包含生产鉴权旁路：

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

容器从仓库根目录构建；应用全部直接依赖使用精确版本，构建时不创建 lockfile，并复制仓库根 TypeScript 基线配置：

```sh
docker build -f apps/admin-web/Dockerfile -t admin-web .
```

镜像构建阶段执行 `pnpm install --lockfile=false`；运行阶段只复制 Next standalone 产物、使用非 root UID 1001 启动 `server.js`，并以 `/login` 作为存活探针。

验收截图：

- `apps/admin-web/output/playwright/acceptance-overview.png`：MFA 后 1280px 总览。
- `apps/admin-web/output/playwright/acceptance-core-flow.png`：运营主流程完成态。
- `apps/admin-web/output/playwright/acceptance-financial-controls.png`：只读复式账本及财务保护态。
- `apps/admin-web/output/playwright/acceptance-rbac-controls.png`：末位超级管理员保护及 RBAC 状态。

axe 在 1280px 下覆盖总览、用户详情、供应商详情、Schema 编辑器、任务详情、财务账本和 IAM；同时逐页验证键盘 Tab 能取得可见焦点。Fluent Tabster 注入且从无障碍树隐藏的焦点哨兵被排除，WCAG A/AA 规则仍全部执行。
