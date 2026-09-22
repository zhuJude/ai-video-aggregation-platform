'use client';

import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Link,
  Text,
  Textarea,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';

import type {
  AuditDirectory,
  ContentDirectory,
  IamDirectory,
  RoleRecord,
  SystemOperation,
  SystemSnapshot,
  TicketDirectory,
  TicketStatus,
} from '../../lib/governance-operations';
import { canTransitionTicket } from '../../lib/governance-policy';
import { ADMIN_PERMISSIONS, hasPermission } from '../../lib/permissions';
import { createUuidV7 } from '../../lib/uuid-v7';

type FormAction = (form: FormData) => void | Promise<void>;

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: '16px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  },
  card: { display: 'grid', gap: '12px', alignContent: 'start' },
  row: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
  stack: { display: 'grid', gap: '8px' },
  metadata: { color: tokens.colorNeutralForeground3, fontFamily: 'Consolas, monospace' },
  internal: {
    borderLeft: `4px solid ${tokens.colorPaletteDarkOrangeBorderActive}`,
    paddingLeft: '12px',
  },
  preview: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '12px',
  },
});

function ReasonConfirmation() {
  return (
    <>
      <Field label="操作原因" required>
        <Textarea name="reason" required />
      </Field>
      <Checkbox label="我已核对影响范围并确认执行" name="confirmed" required value="true" />
    </>
  );
}

function HiddenCommand({
  idKey,
  id,
  version,
  token,
}: Readonly<{
  id: string;
  idKey: string;
  token: string;
  version: number;
}>) {
  return (
    <>
      <input name={idKey} type="hidden" value={id} />
      <input name="expectedVersion" type="hidden" value={String(version)} />
      <input name="preflightToken" type="hidden" value={token} />
      <input name="intentId" type="hidden" value={createUuidV7()} />
    </>
  );
}

const contentPermission: Readonly<Record<'PUBLISH' | 'REORDER' | 'RETIRE' | 'ROLLBACK', string>> = {
  PUBLISH: 'content:publish',
  REORDER: 'content:reorder',
  RETIRE: 'content:retire',
  ROLLBACK: 'content:rollback',
};

const contentOperationLabel: Readonly<Record<keyof typeof contentPermission, string>> = {
  PUBLISH: '发布内容',
  REORDER: '更新排序',
  RETIRE: '下架内容',
  ROLLBACK: '回滚内容',
};

export function ContentConsole({
  onOperation,
  onSave,
  onValidate,
  permissions,
  view,
}: Readonly<{
  onOperation?: FormAction;
  onSave?: FormAction;
  onValidate?: FormAction;
  permissions: readonly string[];
  view: ContentDirectory;
}>) {
  const styles = useStyles();
  return (
    <section aria-labelledby="content-heading" className={styles.stack}>
      <Title2 id="content-heading">内容发布中心</Title2>
      <Text>草稿 → 校验 → 权威预览与差异 → 发布 / 回滚。套餐点数始终按十进制字符串处理。</Text>
      <Text className={styles.metadata}>数据更新：{view.sourceUpdatedAt}</Text>
      <div className={styles.grid}>
        {view.items.map((item) => (
          <Card className={styles.card} key={item.id}>
            <div className={styles.row}>
              <Title3>{item.draft.title}</Title3>
              <Badge>{item.status}</Badge>
            </div>
            <Text className={styles.metadata}>
              /{item.slug} · v{item.version} · 套餐 {item.draft.planPoints} 点
            </Text>
            <div aria-label="安全内容预览" className={styles.preview}>
              {(item.preview?.renderedDocument ?? item.draft.body).blocks.map((block, index) =>
                block.type === 'HEADING' ? (
                  <Title3 key={`${block.type}-${String(index)}`}>{block.text}</Title3>
                ) : block.type === 'LIST_ITEM' ? (
                  <Text as="p" key={`${block.type}-${String(index)}`}>
                    • {block.text}
                  </Text>
                ) : (
                  <Text as="p" key={`${block.type}-${String(index)}`}>
                    {block.text}
                  </Text>
                ),
              )}
            </div>
            <div>
              <Text weight="semibold">校验</Text>
              {item.validation.valid ? (
                <Badge color="success">通过</Badge>
              ) : (
                item.validation.errors.map((error) => <Text key={error}>{error}</Text>)
              )}
            </div>
            {item.preview ? (
              <div className={styles.stack}>
                <Text weight="semibold">版本差异</Text>
                {item.preview.diff.map((line) => (
                  <Text className={styles.metadata} key={line}>
                    {line}
                  </Text>
                ))}
              </div>
            ) : null}
            {item.draftPreviews.map((preview) =>
              preview.operation === 'SAVE_DRAFT' &&
              hasPermission({ permissions }, 'content:write') ? (
                <form action={onSave} className={styles.stack} key={preview.operation}>
                  <HiddenCommand
                    id={item.id}
                    idKey="contentId"
                    token={preview.preflightToken}
                    version={item.version}
                  />
                  <Field label="标题" required>
                    <Input defaultValue={item.draft.title} name="title" required />
                  </Field>
                  <Field label="安全富文本" required>
                    <Textarea
                      defaultValue={item.draft.body.blocks.map((block) => block.text).join('\n')}
                      name="bodyText"
                      required
                    />
                  </Field>
                  <Field label="套餐点数（十进制字符串）" required>
                    <Input
                      defaultValue={item.draft.planPoints}
                      inputMode="numeric"
                      name="planPoints"
                      required
                    />
                  </Field>
                  <ReasonConfirmation />
                  <Button type="submit">保存草稿</Button>
                </form>
              ) : preview.operation === 'VALIDATE' &&
                hasPermission({ permissions }, 'content:validate') ? (
                <form action={onValidate} className={styles.stack} key={preview.operation}>
                  <HiddenCommand
                    id={item.id}
                    idKey="contentId"
                    token={preview.preflightToken}
                    version={item.version}
                  />
                  <ReasonConfirmation />
                  <Button type="submit">校验并生成预览</Button>
                </form>
              ) : null,
            )}
            {item.preview
              ? item.allowedOperations
                  .filter((operation) => operation === item.preview?.operation)
                  .map((operation) =>
                    hasPermission(
                      { permissions },
                      contentPermission[operation as keyof typeof contentPermission],
                    ) ? (
                      <form action={onOperation} className={styles.stack} key={operation}>
                        <HiddenCommand
                          id={item.id}
                          idKey="contentId"
                          token={item.preview?.preflightToken ?? ''}
                          version={item.version}
                        />
                        <input name="operation" type="hidden" value={operation} />
                        <ReasonConfirmation />
                        <Button
                          appearance={operation === 'PUBLISH' ? 'primary' : 'secondary'}
                          type="submit"
                        >
                          {contentOperationLabel[operation as keyof typeof contentOperationLabel]}
                        </Button>
                      </form>
                    ) : null,
                  )
              : null}
          </Card>
        ))}
      </div>
    </section>
  );
}

const ticketTransitionLabel: Readonly<Record<TicketStatus, string>> = {
  CLOSED: '关闭',
  IN_PROGRESS: '开始处理 / 重新打开',
  OPEN: '打开',
  RESOLVED: '解决',
};

export function TicketConsole({
  onMessage,
  onTransition,
  permissions,
  view,
}: Readonly<{
  onMessage?: FormAction;
  onTransition?: FormAction;
  permissions: readonly string[];
  view: TicketDirectory;
}>) {
  const styles = useStyles();
  return (
    <section aria-labelledby="tickets-heading" className={styles.stack}>
      <Title2 id="tickets-heading">工单协作台</Title2>
      <Text className={styles.metadata}>数据更新：{view.sourceUpdatedAt}</Text>
      {view.items.map((ticket) => (
        <Card className={styles.card} key={ticket.id}>
          <div className={styles.row}>
            <Title3>工单 {ticket.id}</Title3>
            <Badge>{ticket.status}</Badge>
          </div>
          {ticket.messages.map((message) => (
            <article
              className={message.visibility === 'INTERNAL_NOTE' ? styles.internal : styles.stack}
              key={message.id}
            >
              <Badge color={message.visibility === 'INTERNAL_NOTE' ? 'warning' : 'brand'}>
                {message.visibility === 'INTERNAL_NOTE' ? '内部备注' : '公开回复'}
              </Badge>
              <Text>{message.body}</Text>
              <Text className={styles.metadata}>
                {message.authorMasked} · {message.createdAt}
              </Text>
              {message.attachments.map((attachment) => (
                <Text key={attachment.fileId}>
                  附件：{attachment.name}（{attachment.mimeType}，{attachment.sizeBytes} B）
                </Text>
              ))}
            </article>
          ))}
          {ticket.messagePreviews.map((preview) => {
            const permission =
              preview.visibility === 'PUBLIC_REPLY'
                ? 'tickets:public-reply'
                : 'tickets:internal-note';
            if (!hasPermission({ permissions }, permission)) return null;
            return (
              <form action={onMessage} className={styles.stack} key={preview.visibility}>
                <HiddenCommand
                  id={ticket.id}
                  idKey="ticketId"
                  token={preview.preflightToken}
                  version={ticket.version}
                />
                <input name="visibility" type="hidden" value={preview.visibility} />
                <Text>{preview.impact}</Text>
                <Field
                  label={preview.visibility === 'PUBLIC_REPLY' ? '公开回复内容' : '内部备注内容'}
                  required
                >
                  <Textarea name="body" required />
                </Field>
                <ReasonConfirmation />
                <Button type="submit">
                  {preview.visibility === 'PUBLIC_REPLY' ? '发送公开回复' : '添加内部备注'}
                </Button>
              </form>
            );
          })}
          {hasPermission({ permissions }, 'tickets:status-write')
            ? ticket.transitionPreviews
                .filter(
                  (preview) =>
                    ticket.allowedTransitions.includes(preview.to) &&
                    canTransitionTicket(
                      ticket.status,
                      preview.to,
                      ticket.resolvedAt,
                      ticket.messages.some(
                        (message) =>
                          message.authorType === 'ADMIN' && message.visibility === 'PUBLIC_REPLY',
                      ),
                    ),
                )
                .map((preview) => (
                  <form action={onTransition} className={styles.stack} key={preview.to}>
                    <HiddenCommand
                      id={ticket.id}
                      idKey="ticketId"
                      token={preview.preflightToken}
                      version={ticket.version}
                    />
                    <input name="expectedStatus" type="hidden" value={ticket.status} />
                    <input name="to" type="hidden" value={preview.to} />
                    <Text>{preview.impact}</Text>
                    <ReasonConfirmation />
                    <Button type="submit">{ticketTransitionLabel[preview.to]}</Button>
                  </form>
                ))
            : null}
        </Card>
      ))}
    </section>
  );
}

function roleFor(directory: IamDirectory, roleId: string): RoleRecord {
  const role = directory.roles.find((candidate) => candidate.id === roleId);
  if (!role) throw new Error('角色不存在');
  return role;
}

export function RoleEditor({
  actorPermissions,
  directory,
  onUpdate,
  roleId,
}: Readonly<{
  actorPermissions: readonly string[];
  directory: IamDirectory;
  onUpdate?: FormAction;
  roleId: string;
}>) {
  const styles = useStyles();
  const role = roleFor(directory, roleId);
  const operation = role.preview?.operation;
  const canMutate =
    operation === 'DELETE'
      ? hasPermission({ permissions: actorPermissions }, 'iam:role-delete')
      : operation === 'UPDATE' &&
        hasPermission({ permissions: actorPermissions }, 'iam:role-write');
  return (
    <Card className={styles.card}>
      <div className={styles.row}>
        <Title3>{role.name}</Title3>
        <Badge>{role.adminCount} 位管理员</Badge>
      </div>
      {role.preview ? (
        <Text>影响 {role.preview.impactedAdminIdsMasked.length} 位管理员</Text>
      ) : null}
      <Text>数据范围：{role.dataScope}</Text>
      {canMutate && role.preview ? (
        <form action={onUpdate} className={styles.stack}>
          <HiddenCommand
            id={role.id}
            idKey="roleId"
            token={role.preview.preflightToken}
            version={role.version}
          />
          <input name="operation" type="hidden" value={role.preview.operation} />
          {role.preview.operation === 'UPDATE' ? (
            <>
              <input name="dataScope" type="hidden" value={role.preview.proposedDataScope ?? ''} />
              {ADMIN_PERMISSIONS.filter((permission) => permission !== '*').map((permission) => {
                const grantable =
                  directory.grantablePermissions.includes(permission) &&
                  hasPermission({ permissions: actorPermissions }, permission);
                return (
                  <Checkbox
                    defaultChecked={role.permissions.includes(permission)}
                    disabled={!grantable}
                    key={permission}
                    label={permission}
                    name="permission"
                    value={permission}
                  />
                );
              })}
            </>
          ) : null}
          <div className={styles.stack}>
            <Text weight="semibold">权限差异</Text>
            <Text>新增：{role.preview.added.join('、') || '无'}</Text>
            <Text>移除：{role.preview.removed.join('、') || '无'}</Text>
          </div>
          <ReasonConfirmation />
          <Button appearance="primary" type="submit">
            {role.preview.operation === 'DELETE' ? '删除角色' : '应用角色变更'}
          </Button>
        </form>
      ) : (
        <Text>当前账号只有查看权限，未呈现可提交表单。</Text>
      )}
    </Card>
  );
}

export function IamConsole({
  actorPermissions,
  directory,
  onAdminUpdate,
  onUpdate,
}: Readonly<{
  actorPermissions: readonly string[];
  directory: IamDirectory;
  onAdminUpdate?: FormAction;
  onUpdate?: FormAction;
}>) {
  const styles = useStyles();
  return (
    <section aria-labelledby="iam-heading" className={styles.stack}>
      <Title2 id="iam-heading">后台权限治理</Title2>
      <Text>可授予权限由服务端权威矩阵决定；变更前展示差异和受影响管理员。</Text>
      <div className={styles.grid}>
        {directory.admins.map((admin) => (
          <Card className={styles.card} key={admin.id}>
            <div className={styles.row}>
              <Title3>{admin.displayNameMasked}</Title3>
              <Badge>{admin.status}</Badge>
            </div>
            <Text>
              数据范围：{admin.dataScope} · MFA：{admin.mfa.enabled ? '已启用' : '未启用'}
            </Text>
            <Text className={styles.metadata}>
              角色 {admin.roleIds.length} 个 · v{admin.version} · 最近 MFA：
              {admin.mfa.lastVerifiedAt ?? '无'}
            </Text>
            {admin.preview &&
            !admin.preview.removesLastSuperAdmin &&
            hasPermission({ permissions: actorPermissions }, 'iam:admin-write') ? (
              <form action={onAdminUpdate} className={styles.stack}>
                <HiddenCommand
                  id={admin.id}
                  idKey="adminId"
                  token={admin.preview.preflightToken}
                  version={admin.version}
                />
                <input name="operation" type="hidden" value={admin.preview.operation} />
                <input name="dataScope" type="hidden" value={admin.preview.proposedDataScope} />
                <input name="status" type="hidden" value={admin.preview.proposedStatus} />
                {admin.preview.proposedRoleIds.map((roleId) => (
                  <input key={roleId} name="roleId" type="hidden" value={roleId} />
                ))}
                <Text>
                  权威预览：{admin.preview.operation} · {admin.preview.proposedDataScope} ·{' '}
                  {admin.preview.proposedStatus}
                </Text>
                <ReasonConfirmation />
                <Button type="submit">应用管理员变更</Button>
              </form>
            ) : null}
          </Card>
        ))}
      </div>
      <div className={styles.grid}>
        {directory.roles.map((role) => (
          <RoleEditor
            actorPermissions={actorPermissions}
            directory={directory}
            key={role.id}
            {...(onUpdate ? { onUpdate } : {})}
            roleId={role.id}
          />
        ))}
      </div>
    </section>
  );
}

export function AuditConsole({
  onExport,
  permissions,
  view,
}: Readonly<{
  onExport?: FormAction;
  permissions: readonly string[];
  view: AuditDirectory;
}>) {
  const styles = useStyles();
  return (
    <section aria-labelledby="audit-heading" className={styles.stack}>
      <Title2 id="audit-heading">不可变审计检索</Title2>
      <form className={styles.grid} method="get">
        <Field label="操作者">
          <Input name="actor" />
        </Field>
        <Field label="动作">
          <Input name="action" />
        </Field>
        <Field label="资源">
          <Input name="resource" />
        </Field>
        <Field label="Trace ID">
          <Input name="traceId" />
        </Field>
        <Field label="开始时间（UTC ISO）">
          <Input
            name="from"
            pattern="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"
            placeholder="2026-09-01T00:00:00.000Z"
          />
        </Field>
        <Field label="结束时间（UTC ISO）">
          <Input
            name="to"
            pattern="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"
            placeholder="2026-09-11T00:00:00.000Z"
          />
        </Field>
        <Button type="submit">检索审计日志</Button>
      </form>
      {view.items.map((item) => (
        <Card className={styles.card} key={item.id}>
          <div className={styles.row}>
            <Badge>{item.action}</Badge>
            <Text>
              {item.resourceType} / {item.resourceIdMasked}
            </Text>
          </div>
          <Text>{item.reason}</Text>
          <Text>
            前：{item.beforeSummary ?? '无'} · 后：{item.afterSummary ?? '无'}
          </Text>
          <Text className={styles.metadata}>
            {item.actorIdMasked} · {item.ipMasked} · {item.userAgentMasked} · {item.at} · Trace{' '}
            {item.traceId}
          </Text>
        </Card>
      ))}
      {view.nextCursor ? (
        <Link href={`/audit?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link>
      ) : null}
      {hasPermission({ permissions }, 'audit:export') && view.exportPreview ? (
        <form action={onExport} className={styles.stack}>
          <input name="format" type="hidden" value="CSV" />
          <input name="intentId" type="hidden" value={createUuidV7()} />
          <input name="preflightToken" type="hidden" value={view.exportPreview.preflightToken} />
          <input
            name="filterFingerprint"
            type="hidden"
            value={view.exportPreview.filterFingerprint}
          />
          {Object.entries(view.exportPreview.filters).map(([key, value]) =>
            value === null ? null : <input key={key} name={key} type="hidden" value={value} />,
          )}
          <ReasonConfirmation />
          <Button type="submit">创建异步 CSV 导出</Button>
        </form>
      ) : null}
    </section>
  );
}

const systemPermission: Readonly<Record<SystemOperation, string>> = {
  SAVE_FLAG_DRAFT: 'system:config-write',
  SAVE_SETTING_DRAFT: 'system:config-write',
  VALIDATE_FLAG: 'system:config-write',
  VALIDATE_SETTING: 'system:config-write',
  PUBLISH_FLAG: 'system:config-publish',
  PUBLISH_SETTING: 'system:config-publish',
  REDRIVE_DLQ: 'system:dlq-redrive',
  ROLLBACK_FLAG: 'system:config-rollback',
  ROLLBACK_SETTING: 'system:config-rollback',
};

export function SystemConsole({
  onOperation,
  permissions,
  view,
}: Readonly<{
  onOperation?: FormAction;
  permissions: readonly string[];
  view: SystemSnapshot;
}>) {
  const styles = useStyles();
  return (
    <section aria-labelledby="system-heading" className={styles.stack}>
      <Title2 id="system-heading">系统运行控制台</Title2>
      <Text className={styles.metadata}>数据更新：{view.sourceUpdatedAt}</Text>
      <div className={styles.grid}>
        <Card className={styles.card}>
          <Title3>服务健康</Title3>
          {view.services.map((service) => (
            <div className={styles.row} key={service.name}>
              <Badge color={service.status === 'HEALTHY' ? 'success' : 'danger'}>
                {service.status}
              </Badge>
              <Text>
                {service.name} · {service.latencyMs} ms
              </Text>
            </div>
          ))}
        </Card>
        <Card className={styles.card}>
          <Title3>版本与 Freshness</Title3>
          {view.releases.map((release) => (
            <Text key={release.service}>
              {release.service}: {release.version} · {release.environment} ·{' '}
              {release.digest.slice(0, 12)}… · {release.deployedAt}
            </Text>
          ))}
          {view.freshness.map((freshness) => (
            <Text className={styles.metadata} key={freshness.source}>
              {freshness.source}: {freshness.updatedAt}
            </Text>
          ))}
        </Card>
        <Card className={styles.card}>
          <Title3>告警</Title3>
          {view.alerts.map((alert) => (
            <div className={styles.stack} key={alert.id}>
              <div className={styles.row}>
                <Badge color="danger">{alert.severity}</Badge>
                <Text>{alert.summary}</Text>
              </div>
              <Text>
                负责人 {alert.ownerMasked} · 关闭条件 {alert.closeCondition}
              </Text>
              <Link href={alert.runbookUrl} rel="noreferrer" target="_blank">
                Runbook
              </Link>
            </div>
          ))}
        </Card>
        <Card className={styles.card}>
          <Title3>可信观测入口</Title3>
          {view.links.map((link) => (
            <Link href={link.url} key={link.url} rel="noreferrer" target="_blank">
              {link.label}
            </Link>
          ))}
        </Card>
      </div>
      <Card className={styles.card}>
        <Title3>版本化配置</Title3>
        <Text>
          Feature flags v{view.config.flagsVersion} · Settings v{view.config.settingsVersion}
        </Text>
        <Text>
          Flag 校验：
          {view.config.featureFlags.validation.valid
            ? '通过'
            : view.config.featureFlags.validation.errors.join('、')}
        </Text>
        {view.config.featureFlags.diff.map((line) => (
          <Text className={styles.metadata} key={line}>
            {line}
          </Text>
        ))}
        <Text>
          公开设置校验：
          {view.config.publicSettings.validation.valid
            ? '通过'
            : view.config.publicSettings.validation.errors.join('、')}
        </Text>
        {view.config.publicSettings.diff.map((line) => (
          <Text className={styles.metadata} key={line}>
            {line}
          </Text>
        ))}
        {view.config.publicSettings.secretReferences.map((secret) => (
          <Text className={styles.metadata} key={secret.name}>
            {secret.name}: {secret.masked} · {secret.kmsReference}
          </Text>
        ))}
        {view.config.preview &&
        hasPermission({ permissions }, systemPermission[view.config.preview.operation]) ? (
          <form action={onOperation} className={styles.stack}>
            <HiddenCommand
              id={
                view.config.preview.operation.includes('FLAG') ? 'feature-flags' : 'public-settings'
              }
              idKey="resourceId"
              token={view.config.preview.preflightToken}
              version={
                view.config.preview.operation.includes('FLAG')
                  ? view.config.flagsVersion
                  : view.config.settingsVersion
              }
            />
            <input name="operation" type="hidden" value={view.config.preview.operation} />
            {view.config.preview.operation === 'SAVE_FLAG_DRAFT' ? (
              <>
                <Field label="Flag key">
                  <Input name="flagKey" required />
                </Field>
                <Field label="启用">
                  <Input name="enabled" required />
                </Field>
                <Field label="Rollout bps">
                  <Input name="rolloutBps" required />
                </Field>
              </>
            ) : null}
            {view.config.preview.operation === 'SAVE_SETTING_DRAFT' ? (
              <>
                <Field label="公开域名">
                  <Input name="publicDomain" required />
                </Field>
                <Field label="公开回调 URL">
                  <Input name="publicCallbackUrl" required />
                </Field>
                <Field label="替换密钥（只写）">
                  <Input name="replacementSecret" required type="password" />
                </Field>
              </>
            ) : null}
            <Text>{view.config.preview.impact}</Text>
            <ReasonConfirmation />
            <Button type="submit">执行配置变更</Button>
          </form>
        ) : null}
      </Card>
      <div className={styles.grid}>
        {view.queues.map((queue) => (
          <Card className={styles.card} key={queue.name}>
            <Title3>队列 {queue.name}</Title3>
            <Text>
              深度 {queue.depth} · DLQ {queue.dlq}
            </Text>
            {queue.preview ? (
              <Text>
                业务键 {queue.preview.businessKey} · 当前结果 {queue.preview.currentOutcome} ·
                幂等/计费/采购安全{' '}
                {queue.preview.idempotencySafe &&
                queue.preview.billingSafe &&
                queue.preview.purchaseSafe
                  ? '通过'
                  : '未通过'}
              </Text>
            ) : null}
            {queue.preview &&
            queue.preview.idempotencySafe &&
            queue.preview.billingSafe &&
            queue.preview.purchaseSafe &&
            hasPermission({ permissions }, 'system:dlq-redrive') ? (
              <form action={onOperation} className={styles.stack}>
                <HiddenCommand
                  id={queue.name}
                  idKey="resourceId"
                  token={queue.preview.preflightToken}
                  version={queue.version}
                />
                <input name="operation" type="hidden" value="REDRIVE_DLQ" />
                <Text>{queue.preview.impact}</Text>
                <ReasonConfirmation />
                <Button type="submit">安全重放 DLQ</Button>
              </form>
            ) : null}
          </Card>
        ))}
      </div>
    </section>
  );
}
