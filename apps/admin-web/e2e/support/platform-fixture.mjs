const IDS = Object.freeze({
  actor: '0198f7a4-c6d0-7b39-8a4e-73af0c1d2e3f', role: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
  content: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', ticket: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
  audit: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', request: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f',
  attachment: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f', reviewer: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f',
  reconciliation: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', compensation: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
  transaction: '0198f7a4-c6dc-7b39-8a4e-73af0c1d2e3f', entry: '0198f7a4-c6dd-7b39-8a4e-73af0c1d2e3f',
  provider: '0198f7a4-c7d0-7b39-8a4e-73af0c1d2e3f', model: '0198f7a4-c7d1-7b39-8a4e-73af0c1d2e3f',
  capabilityVersion: '0198f7a4-c7d2-7b39-8a4e-73af0c1d2e3f', task: '0198f7a4-c7d3-7b39-8a4e-73af0c1d2e3f',
  pricingVersion: '0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f', routingVersion: '0198f7a4-c7d5-7b39-8a4e-73af0c1d2e3f',
  user: '0198f7a4-c7d6-7b39-8a4e-73af0c1d2e3f', order: '0198f7a4-c7d7-7b39-8a4e-73af0c1d2e3f',
  secondaryAdmin: '0198f7a4-c7d8-7b39-8a4e-73af0c1d2e3f', secondaryRole: '0198f7a4-c7d9-7b39-8a4e-73af0c1d2e3f',
});
const timestamp = '2026-09-11T00:00:00.000Z';
const future = '2099-09-11T00:00:00.000Z';
const soon = new Date(Date.now() + 10 * 60_000).toISOString();
const challengeById = new Map();
const reply = (payload, status = 200) => ({ body: JSON.stringify(payload), headers: { 'content-type': 'application/json' }, status });
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); const value = Buffer.concat(chunks).toString('utf8'); return value ? JSON.parse(value) : {}; }
class FixtureInputError extends Error {}
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRACE_ID = /^[0-9a-f]{32}$/iu;
function exactObject(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new FixtureInputError(`expected exact keys ${keys.join(',')}`); return value; }
function actorFrom(request) { const token = request.headers['x-admin-session-token']; if (typeof token !== 'string' || token.length > 3000 || token.split('.').length !== 2) return null; try { const subjectId = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).subjectId; return UUID_V7.test(subjectId) ? subjectId : null; } catch { return null; } }
function expectedServiceIdentity(path) {
  if (path.startsWith('/v1/admin-auth/')) return ['x-service-identity-ref', 'kms://e2e/admin-auth'];
  if (path.startsWith('/v1/admin/models')) return ['x-service-identity-kms-ref', 'kms://e2e/catalog'];
  if (path.startsWith('/v1/admin/providers')) return ['x-service-identity-kms-ref', 'kms://e2e/operations'];
  if (path.startsWith('/v1/admin/users/')) return ['x-service-identity-ref', 'kms://e2e/operations'];
  if (path.startsWith('/admin/')) return ['x-service-identity-kms-ref', 'kms://e2e/operations'];
  throw new FixtureInputError('unknown mutation service identity');
}
function requireMutationHeaders(request, path, { idempotency = true, session = true } = {}) {
  const h = request.headers; const [identityHeader, identityValue] = expectedServiceIdentity(path);
  const otherIdentityHeader = identityHeader === 'x-service-identity-ref' ? 'x-service-identity-kms-ref' : 'x-service-identity-ref';
  const invalid = [];
  if (h[identityHeader] !== identityValue || h[otherIdentityHeader] !== undefined) invalid.push('service-identity');
  if (!TRACE_ID.test(String(h['x-trace-id'] ?? ''))) invalid.push('trace-id');
  if (!UUID_V7.test(String(h['x-correlation-id'] ?? ''))) invalid.push('correlation-id');
  if (h['content-type'] !== 'application/json') invalid.push('content-type');
  if (session ? !actorFrom(request) : h['x-admin-session-token'] !== undefined) invalid.push('admin-session');
  if (idempotency ? !UUID_V7.test(String(h['idempotency-key'] ?? '')) : h['idempotency-key'] !== undefined) invalid.push('idempotency-key');
  if (invalid.length > 0) throw new FixtureInputError(`invalid mutation headers: ${invalid.join(',')}`);
}
function exactAudit(input, request, reason) { const audit = exactObject(input.audit, ['idempotencyKey', 'reason']); const reasons = Array.isArray(reason) ? reason : [reason]; if (audit.idempotencyKey !== request.headers['idempotency-key'] || !reasons.includes(audit.reason)) throw new FixtureInputError('invalid audited mutation context'); return audit; }
function exactHeaderAudit(input, request) { const audit = exactObject(input.audit, ['idempotencyKey']); if (audit.idempotencyKey !== request.headers['idempotency-key']) throw new FixtureInputError('invalid mutation idempotency binding'); return audit; }
function sameJson(left, right) { const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value; return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function allowedMethods(path) {
  if (path === '/__health' || path === '/__calls') return ['GET']; if (path === '/__reset') return ['POST'];
  if (path === '/v1/admin-auth/password/challenges' || path === '/v1/admin-auth/totp/verifications') return ['POST'];
  if (path === '/v1/admin/providers') return ['GET', 'POST'];
  if (/^\/v1\/admin\/(providers\/[^/]+|models|models\/[^/]+\/capabilities|reporting\/overview)$/u.test(path)) return ['GET'];
  if (/\/capabilities\/commands$/u.test(path)) return ['POST'];
  if (/^\/v1\/admin\/users\/[^/]+\/(detail|authorization-scope)$/u.test(path)) return ['GET'];
  if (/^\/v1\/admin\/users\/[^/]+\/eligible-approvers$/u.test(path)) return ['POST'];
  if (/^\/v1\/admin\/users\/[^/]+\/wallet-adjustment-requests\/[^/]+$/u.test(path)) return ['GET'];
  if (/^\/v1\/admin\/users\/[^/]+\/(wallet-adjustment-previews|wallet-adjustment-requests)$/u.test(path) || /\/wallet-adjustment-requests\/[^/]+\/(approval-previews|approvals)$/u.test(path)) return ['POST'];
  if (['/admin/pricing/current','/admin/routing/current','/admin/tasks','/admin/finance/reconciliation','/admin/finance/ledger','/admin/finance/orders','/admin/content','/admin/tickets','/admin/iam'].includes(path) || /^\/admin\/(tasks|content|tickets)\/[^/]+$/u.test(path) || /^\/admin\/tasks\/[^/]+\/raw$/u.test(path) || /^\/admin\/finance\/reconciliation\/[^/]+$/u.test(path)) return ['GET'];
  if (['/admin/pricing/preview','/admin/pricing/publish','/admin/routing/simulate'].includes(path) || /\/compensation-requests$/u.test(path) || /\/compensation-requests\/[^/]+\/approvals$/u.test(path) || /\/content\/[^/]+\/operations$/u.test(path) || /\/tickets\/[^/]+\/transitions$/u.test(path)) return ['POST'];
  return null;
}
function send(response, value) { response.writeHead(value.status, value.headers); response.end(value.body); }

const providerRow = () => ({ circuitState: 'CLOSED', health: 'HEALTHY', id: IDS.provider, latencyP95Ms: 320, name: '星河视频供应商', sourceUpdatedAt: timestamp, status: 'ENABLED', successRateBps: 9980 });
const providerDetail = (actor) => ({ ...providerRow(), alert: { channels: ['SLS'], owner: '供应商值班组' }, assignedAdminIds: [actor], auth: { kmsIdentityReference: 'kms://providers/star/runtime', method: 'API_KEY' }, balance: { amount: '9823400', threshold: '1000000', unit: 'PROVIDER_CREDITS' }, callback: { configured: true, mode: 'SIGNED_WEBHOOK', verificationKmsReference: 'kms://providers/star/callback' }, credentials: [{ audit: { lastAccessedAt: timestamp, lastAccessedBy: actor }, id: IDS.attachment, kmsReference: 'kms://providers/star/production', masked: 'sk_****7d2a', rotatedAt: timestamp, rotatedBy: actor, scope: ['TASK_CREATE'], status: 'ACTIVE' }], interface: { baseUrl: 'https://provider.example.com/v1', protocol: 'REST_JSON', timeoutMs: 5000 }, lastProbe: { checkedAt: timestamp, message: 'ready', traceId: '00112233445566778899aabbccddeeff' }, maintenanceWindow: null, ownerAdminId: actor, procurement: { costUnit: 'PROVIDER_CREDITS', discountBps: 8500 }, rateLimits: { concurrency: 24, requests: 120, windowSeconds: 60 }, version: 7 });
const definition = { costDimensions: ['duration'], providerMapping: { duration: 'duration_seconds' }, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', additionalProperties: false, properties: { duration: { enum: [5, 10], type: 'integer' } }, required: ['duration'], type: 'object' }, uiSchema: { fields: [{ label: '时长', name: 'duration', order: 1, unit: '秒' }] } };
const capability = (actor, state) => ({ assignedAdminIds: [actor], definition, history: [{ createdAt: timestamp, id: IDS.capabilityVersion, status: state.capabilityPublished ? 'PUBLISHED' : 'DRAFT', version: 7 }], model: { code: 'video_fast', displayName: '视频极速模型', id: IDS.model, providerId: IDS.provider }, ownerAdminId: actor, publishedDefinition: state.capabilityPublished ? definition : null, sourceUpdatedAt: timestamp, status: state.capabilityPublished ? 'PUBLISHED' : 'DRAFT', version: 7, versionId: IDS.capabilityVersion });
const pricing = (state) => ({ costPoints: '1000', effectiveAt: future, minimumMarginBps: 2000, rules: [{ costPoints: '1000', durationSeconds: 5, id: 'video-fast-5s', markupBps: 5000, modelCode: 'video_fast', parameterKey: 'duration=5', resolution: '1080p', salePoints: '1500', strategy: 'FIXED', tiersJson: '[]' }], salePoints: '1500', sourceUpdatedAt: timestamp, status: state.pricingPublished ? 'PUBLISHED' : 'DRAFT', version: 7, versionId: IDS.pricingVersion, versions: [] });
const routing = () => ({ backupCapabilityMapJson: '{"video_fast":["provider-b"]}', effectiveAt: future, failoverMode: 'SMART_ONLY', minimumMarginBps: 2000, priceWeight: 20, providerPriorityJson: '["provider-a","provider-b"]', publishPreflight: null, qualityWeight: 50, sourceUpdatedAt: timestamp, speedWeight: 30, status: 'DRAFT', version: 7, versionId: IDS.routingVersion, versions: [] });
const taskDetail = (actor) => ({ allowedOperations: ['RETRY_PROVIDER', 'CANCEL'], assignedAdminIds: [actor], attempt: { acceptance: 'AMBIGUOUS', circuitState: 'HALF_OPEN', externalTaskIdMasked: 'ext_****1234', number: 2, providerName: '星河视频供应商' }, duplicatePurchaseRisk: true, financial: { chargedPoints: '1200', costPoints: '800', frozenPoints: '0', refundedPoints: '0' }, id: IDS.task, operationPreviews: [{ impact: '可能产生新的供应商采购', operation: 'RETRY_PROVIDER', preflightToken: 'task-pf-retry-safe', purchaseSafety: 'NOT_ACCEPTED' }, { impact: '释放冻结点数', operation: 'CANCEL', preflightToken: 'task-pf-cancel-safe', purchaseSafety: 'NOT_APPLICABLE' }], ownerAdminId: actor, parameterSnapshot: { duration: 5, prompt: '海边日落' }, publicError: null, queue: { enqueuedAt: timestamp, priority: 5, shard: 'video-cn-1' }, rawExchange: { request: { authorization: '[REDACTED]', prompt: '海边日落' }, response: { requestId: 'safe-request-id', token: '[REDACTED]' } }, sourceUpdatedAt: timestamp, status: 'PROVIDER_PENDING', timeline: [{ at: timestamp, code: 'CREATED', label: '任务已创建' }], userIdMasked: 'usr_****d2e3f', version: 4 });
const userDetail = (state) => ({ allowedStatusTransitions: ['SUSPENDED'], canRequestWalletAdjustment: true, deniedTabs: [], eligibleApprovers: [{ displayName: '复核管理员', id: IDS.reviewer }], tabs: [{ account: { createdAt: timestamp, displayName: '测试用户', phoneMasked: '138****8000', registrationSource: 'WEB', status: 'ACTIVE', spendingTier: 'HIGH', tags: [{ value: 'vip' }] }, id: 'account', session: { devices: [], lastActiveAt: timestamp, loginRecords: [], status: 'ACTIVE' }, status: 'READY' }, { id: 'tasks', items: [], status: 'EMPTY' }, { adjustmentHistory: state.walletAdjustmentRequested ? [{ approverId: IDS.reviewer, direction: 'CREDIT', id: IDS.request, occurredAt: timestamp, points: '10', requestedById: IDS.actor, status: state.walletAdjustmentApproved ? 'APPROVED' : 'PENDING_APPROVAL', version: state.walletAdjustmentApproved ? 2 : 1 }] : [], balance: state.walletAdjustmentApproved ? '110' : '100', consumptionHistory: [], frozenBalance: '0', id: 'wallet', rechargeHistory: [], status: 'READY', unit: 'POINTS' }, { id: 'orders', items: [], status: 'EMPTY' }, { id: 'tickets', items: [], status: 'EMPTY' }, { id: 'audit', items: state.walletAdjustmentApproved ? [{ action: 'WALLET_ADJUSTMENT_APPROVED', id: IDS.audit, occurredAt: timestamp }] : [], status: state.walletAdjustmentApproved ? 'READY' : 'EMPTY' }], user: { displayName: '测试用户', id: IDS.user, phoneMasked: '138****8000', status: 'ACTIVE' } });
const reconciliation = (state) => ({ assignedAdminIds: [IDS.actor], category: 'AMOUNT_MISMATCH', channelAmountFen: '8800', channelStatus: 'SUCCESS', compensationRequest: state.compensationCreated ? { allowedApproval: state.compensationApproved ? null : { expiresAt: soon, impact: '完成第二人复核后新增平衡分录', preflightToken: 'recon-approval-signed-token', resultStatus: 'APPROVED' }, approvals: state.compensationApproved ? [{ approvedAt: timestamp, approverId: IDS.attachment }, { approvedAt: timestamp, approverId: IDS.reviewer }] : [{ approvedAt: timestamp, approverId: IDS.attachment }], id: IDS.compensation, requestedById: IDS.actor, status: state.compensationApproved ? 'APPROVED' : 'PENDING_APPROVAL' } : null, id: IDS.reconciliation, ownerAdminId: IDS.actor, platformAmountFen: '8000', platformStatus: 'PAID', repairPreflight: state.compensationCreated ? null : { approvalPolicy: { prohibitRequesterApproval: true, requiredApprovals: 2 }, expiresAt: soon, impact: '新增平衡补偿分录 800 点，不修改历史分录', preflightToken: 'recon-preflight-signed-token' }, runbookPath: '/runbooks/wallet-payment#reconciliation', status: state.compensationApproved ? 'REPAIRED' : 'OPEN', version: state.compensationCreated ? 8 : 7 });
const contentItem = (state) => ({ allowedOperations: state.contentPublished ? [] : ['PUBLISH'], assignedAdminIds: [IDS.actor], draft: { body: { blocks: [{ text: '安全公告', type: 'PARAGRAPH' }] }, planPoints: '9007199254740993', title: '服务升级公告' }, draftPreviews: [], id: IDS.content, ownerAdminId: IDS.actor, preview: state.contentPublished ? null : { diff: ['+ 服务升级公告'], expiresAt: soon, operation: 'PUBLISH', preflightToken: 'content-preview-signed-token', renderedDocument: { blocks: [{ text: '安全公告', type: 'PARAGRAPH' }] }, resultStatus: 'PUBLISHED', resultVersion: 4 }, publishedVersion: state.contentPublished ? 4 : null, slug: 'service-upgrade', status: state.contentPublished ? 'PUBLISHED' : 'DRAFT_VALIDATED', validation: { errors: [], valid: true }, version: state.contentPublished ? 4 : 3 });
const ticketItem = (state) => ({ allowedTransitions: state.ticketResolved ? [] : ['RESOLVED'], assignedAdminIds: [IDS.actor], id: IDS.ticket, messagePreviews: [{ allowedAttachmentFileIds: [], expiresAt: soon, impact: '向用户发送公开回复', preflightToken: 'ticket-message-preflight', resultVersion: 6, visibility: 'PUBLIC_REPLY' }], messages: [{ attachments: [], authorMasked: 'admin-****01', authorType: 'ADMIN', body: '已确认处理进度', createdAt: timestamp, id: IDS.audit, visibility: 'PUBLIC_REPLY' }], ownerAdminId: IDS.actor, resolvedAt: state.ticketResolved ? timestamp : null, status: state.ticketResolved ? 'RESOLVED' : 'IN_PROGRESS', transitionPreviews: state.ticketResolved ? [] : [{ expiresAt: soon, impact: '解决工单并记录审计', preflightToken: 'ticket-resolve-preflight', resultVersion: 6, to: 'RESOLVED' }], version: state.ticketResolved ? 6 : 5 });
const order = (actor, state) => ({
  allowedOperations: [], amountFen: '8800', assignedAdminIds: [actor],
  callbackSummary: { duplicate: false, eventId: 'channel-event-001', status: 'VERIFIED', verifiedAt: timestamp },
  currency: 'CNY',
  exceptionSummary: {
    at: timestamp,
    code: state.compensationApproved ? 'RECONCILIATION_REPAIRED' : 'RECONCILIATION_REQUIRED',
    message: state.compensationApproved
      ? `对账案件 ${IDS.reconciliation} 已修复`
      : `待对账案件 ${IDS.reconciliation}`,
  },
  id: IDS.order, operationPreviews: [], ownerAdminId: actor,
  refundSummary: { amountFen: '8800', currency: 'CNY', gatewayStatus: 'NOT_REQUESTED', refundId: null, walletStatus: 'NOT_REQUESTED' },
  status: 'PAID',
  timeline: [{ actor: '支付网关', at: timestamp, event: 'CALLBACK_VERIFIED', id: IDS.audit, note: '支付回调验签成功，金额差异转入渠道对账', traceId: '1123456789abcdef0123456789abcdef' }],
  userIdMasked: 'usr_****d2e3f', version: state.compensationApproved ? 5 : 4,
});
function iam(actor) {
  const superPreview = { actorImpacted: true, expiresAt: soon, operation: 'UPDATE_STATUS', preflightToken: 'iam-disable-last-super-token', proposedDataScope: 'ALL', proposedRoleIds: [IDS.role], proposedStatus: 'DISABLED', removesLastSuperAdmin: true, resultVersion: 4 };
  const safePreview = { actorImpacted: false, expiresAt: soon, operation: 'UPDATE_STATUS', preflightToken: 'iam-disable-secondary-token', proposedDataScope: 'ALL', proposedRoleIds: [IDS.secondaryRole], proposedStatus: 'DISABLED', removesLastSuperAdmin: false, resultVersion: 2 };
  return {
    actorAdminId: actor,
    admins: [
      { dataScope: 'ALL', displayNameMasked: 'admin-****01', id: actor, mfa: { enabled: true, lastVerifiedAt: timestamp }, preview: superPreview, roleIds: [IDS.role], status: 'ACTIVE', version: 3 },
      { dataScope: 'ALL', displayNameMasked: 'admin-****02', id: IDS.secondaryAdmin, mfa: { enabled: true, lastVerifiedAt: timestamp }, preview: safePreview, roleIds: [IDS.secondaryRole], status: 'ACTIVE', version: 1 },
    ],
    grantablePermissions: ['users:read', 'tickets:read'],
    roles: [
      { adminCount: 1, assignedAdminIds: [actor], dataScope: 'ALL', id: IDS.role, isSuperAdmin: true, name: '超级管理员', ownerAdminId: actor, permissions: ['users:read', 'tickets:read'], preview: null, version: 7 },
      { adminCount: 1, assignedAdminIds: [IDS.secondaryAdmin], dataScope: 'ALL', id: IDS.secondaryRole, isSuperAdmin: false, name: '只读管理员', ownerAdminId: actor, permissions: ['users:read'], preview: null, version: 1 },
    ],
    sourceUpdatedAt: timestamp,
    superAdminCount: 1,
  };
}
function authSubject(identifier) { if (identifier === 'reviewer@example.com') return { dataScope: 'ALL', permissions: ['overview:read', 'users:read', 'finance:read', 'wallet:adjust', 'finance:reconciliation-approve'], subjectId: IDS.reviewer }; if (identifier === 'viewer@example.com') return { dataScope: 'ALL', permissions: ['overview:read'], subjectId: IDS.attachment }; return { dataScope: 'ALL', permissions: ['*'], subjectId: IDS.actor }; }

export function createFixtureHandler() {
  const state = { capabilityPublished: false, compensationApproved: false, compensationCreated: false, contentPublished: false, pricingPublished: false, ticketResolved: false, walletAdjustmentApproved: false, walletAdjustmentRequested: false };
  const calls = { compensationApprovals: 0, contentOperations: 0, iamCommands: 0, walletAdjustmentApprovals: 0 };
  const reset = () => { Object.assign(state, { capabilityPublished: false, compensationApproved: false, compensationCreated: false, contentPublished: false, pricingPublished: false, ticketResolved: false, walletAdjustmentApproved: false, walletAdjustmentRequested: false }); Object.keys(calls).forEach((key) => { calls[key] = 0; }); };
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'https://127.0.0.1:3211'); const path = url.pathname; const actor = actorFrom(request);
      const allowed = allowedMethods(path); if (allowed && !allowed.includes(request.method)) { send(response, reply({ error: 'METHOD_NOT_ALLOWED', allowed, method: request.method }, 405)); return; }
      if (request.method === 'POST' && path !== '/__reset') {
        const idempotency = !['/admin/pricing/preview', '/admin/routing/simulate'].includes(path) && !path.endsWith('/eligible-approvers');
        requireMutationHeaders(request, path, { idempotency, session: !path.startsWith('/v1/admin-auth/') });
      }
      let value;
      if (path === '/__health') value = reply({ ok: true });
      else if (path === '/__reset' && request.method === 'POST') { reset(); value = reply({ ok: true }); }
      else if (path === '/__calls') value = reply({ calls: { ...calls }, state: { ...state } });
      else if (path === '/v1/admin-auth/password/challenges') { const input = exactObject(await body(request), ['identifier', 'password']); if (typeof input.identifier !== 'string' || !['admin@example.com', 'reviewer@example.com', 'viewer@example.com'].includes(input.identifier) || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) throw new FixtureInputError('invalid password challenge'); const challengeId = Buffer.alloc(32, input.identifier.charCodeAt(0) || 1).toString('base64url'); challengeById.set(challengeId, input.identifier); value = reply({ challengeId, expiresInSeconds: 600 }); }
      else if (path === '/v1/admin-auth/totp/verifications') { const input = exactObject(await body(request), ['challengeId', 'code']); const identifier = challengeById.get(input.challengeId); if (!identifier || typeof input.code !== 'string' || !/^\d{6}$/u.test(input.code)) throw new FixtureInputError('invalid TOTP verification'); value = input.code === '123456' ? reply({ expiresAt: Date.now() + 3_600_000, kind: 'AUTHENTICATED', subject: authSubject(identifier) }) : reply({ attemptsRemaining: 4, kind: 'REJECTED', reason: 'INVALID_CODE' }, 401); }
      else if (path === '/v1/admin/reporting/overview') value = reply({ datasets: [
        { id: 'operations', label: '运营指标', sourceTimestamp: timestamp, status: 'READY', measures: [
          { id: 'registrations', label: '注册用户', value: '100' },
          { id: 'active-users', label: '活跃用户', value: '42' },
          { id: 'recharge-points', label: '充值点数', value: '1000' },
          { id: 'consumption-points', label: '消耗点数', value: '500' },
        ] },
        { id: 'tasks', label: '任务与队列', sourceTimestamp: timestamp, status: 'READY', measures: [
          { id: 'task-count', label: '任务数', value: '42' },
          { id: 'success-rate', label: '成功率', value: '99.95%' },
          { id: 'average-generation-duration', label: '平均生成时长', unit: 'SECONDS', value: '12' },
          { id: 'queue-backlog', label: '队列积压', value: '8' },
        ] },
        { id: 'finance', label: '财务指标', sourceTimestamp: timestamp, status: 'READY', measures: [
          { currency: 'CNY', id: 'income', label: '收入', minorUnits: '880000' },
          { currency: 'CNY', id: 'provider-cost', label: '供应商成本', minorUnits: '450000' },
          { currency: 'CNY', direction: 'CREDIT', id: 'gross-margin', label: '毛利', minorUnits: '430000' },
          { id: 'gross-margin-rate', label: '毛利率', value: '48.86%' },
          { currency: 'CNY', id: 'average-revenue-per-user', label: '客单价', minorUnits: '23810' },
          { id: 'repeat-purchase-rate', label: '复购率', value: '42.50%' },
        ] },
        { id: 'supplier-risk', label: '供应商与风险', sourceTimestamp: timestamp, status: 'READY', measures: [
          { id: 'supplier-balance', label: '供应商余额', value: '9823400' },
          { id: 'supplier-failure-rate', label: '供应商失败率', value: '0.20%' },
          { id: 'payment-anomalies', label: '支付异常', value: '0' },
          { id: 'service-alerts', label: '服务告警', value: '0' },
        ] },
      ] });
      else if (path === '/v1/admin/providers' && request.method === 'GET') value = reply({ items: [providerRow()], partialFields: [], sourceUpdatedAt: timestamp });
      else if (path === '/v1/admin/providers' && request.method === 'POST') { const input = exactObject(await body(request), ['audit', 'metadata']); const audit = exactObject(input.audit, ['actorId', 'reason']); const metadata = exactObject(input.metadata, ['authMethod', 'baseUrl', 'callbackMode', 'maintenanceWindow', 'name', 'ownerAdminId']); if (audit.actorId !== actor || audit.reason !== '接入新的合规供应商' || !sameJson(metadata, { authMethod: 'API_KEY', baseUrl: 'https://north.example.com/v1', callbackMode: 'NONE', maintenanceWindow: null, name: '北极星视频', ownerAdminId: IDS.actor })) throw new FixtureInputError(`invalid provider metadata ${JSON.stringify(input)}`); value = reply({ auditRecordId: IDS.audit, providerId: IDS.provider, requestId: IDS.request, status: 'ENABLED', version: 1 }); }
      else if (path === `/v1/admin/providers/${IDS.provider}`) value = reply(providerDetail(actor));
      else if (path === '/v1/admin/models') value = reply({ items: [{ assignedAdminIds: [actor], code: 'video_fast', displayName: '视频极速模型', draftVersion: state.capabilityPublished ? null : 7, id: IDS.model, ownerAdminId: actor, providerId: IDS.provider, providerName: '星河视频供应商', publishedVersion: state.capabilityPublished ? 7 : null, sourceUpdatedAt: timestamp, status: state.capabilityPublished ? 'PUBLISHED' : 'DRAFT' }], partialFields: [], sourceUpdatedAt: timestamp });
      else if (path === `/v1/admin/models/${IDS.model}/capabilities`) value = reply(capability(actor, state));
      else if (path === `/v1/admin/models/${IDS.model}/capabilities/commands`) { const candidate = await body(request); if (!candidate || typeof candidate !== 'object' || !['SAVE', 'VALIDATE', 'PUBLISH'].includes(candidate.kind)) throw new FixtureInputError(`invalid capability command ${JSON.stringify(candidate)}`); const keys = candidate.kind === 'PUBLISH' ? ['audit', 'expectedVersion', 'kind', 'preflightToken', 'sourceVersionId'] : ['audit', 'definition', 'expectedVersion', 'kind', 'sourceVersionId']; const input = exactObject(candidate, keys); const audit = exactObject(input.audit, ['actorId', 'reason']); const expectedReason = input.kind === 'SAVE' ? 'save capability draft' : input.kind === 'VALIDATE' ? 'validate capability draft' : '通过能力和定价校验'; if (audit.actorId !== actor || audit.reason !== expectedReason || input.expectedVersion !== 7 || input.sourceVersionId !== IDS.capabilityVersion || (input.kind === 'PUBLISH' ? input.preflightToken !== 'pf_abcdefghijklmnopqrstuvwxyz123456' : !sameJson(input.definition, definition))) throw new FixtureInputError(`invalid capability command ${JSON.stringify(input)}`); const key = String(request.headers['idempotency-key']); if (input.kind === 'VALIDATE') value = reply({ diff: { added: [], changed: [], removed: [] }, errors: [], expectedVersion: 7, modelId: IDS.model, preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456', pricingImpact: '定价仍然有效', valid: true }); else { if (input.kind === 'PUBLISH') state.capabilityPublished = true; value = reply({ auditRecordId: IDS.audit, idempotencyKey: key, kind: input.kind, modelId: IDS.model, requestId: IDS.request, sourceVersionId: IDS.capabilityVersion, status: input.kind === 'PUBLISH' ? 'PUBLISHED' : 'DRAFT', targetVersionId: null, version: 8, versionId: IDS.capabilityVersion }); } }
      else if (path === '/admin/pricing/current') value = reply(pricing(state));
      else if (path === '/admin/pricing/preview') { const input = exactObject(await body(request), ['effectiveAt', 'expectedVersion', 'markupBps', 'ruleId', 'salePoints', 'strategy', 'tiers', 'versionId']); if (input.effectiveAt !== future || input.expectedVersion !== 7 || input.markupBps !== 5000 || input.ruleId !== 'video-fast-5s' || input.salePoints !== '1500' || input.strategy !== 'FIXED' || !sameJson(input.tiers, []) || input.versionId !== IDS.pricingVersion) throw new FixtureInputError('invalid pricing preview'); value = reply({ expiresAt: future, previewToken: 'pricing-preview-token', version: 7, versionId: IDS.pricingVersion }); }
      else if (path === '/admin/pricing/publish') { const input = exactObject(await body(request), ['actorId', 'audit', 'confirmed', 'expectedVersion', 'previewToken', 'versionId']); exactAudit(input, request, '同步已发布模型能力'); if (input.actorId !== actor || input.confirmed !== true || input.expectedVersion !== 7 || input.previewToken !== 'pricing-preview-token' || input.versionId !== IDS.pricingVersion) throw new FixtureInputError('invalid pricing publish'); state.pricingPublished = true; value = reply({ ok: true }); }
      else if (path === '/admin/routing/current') value = reply(routing());
      else if (path === '/admin/routing/simulate') { const input = exactObject(await body(request), ['parameters']); const parameters = exactObject(input.parameters, ['duration', 'expectedVersion', 'resolution', 'routingVersionId']); if (parameters.duration !== 5 || parameters.expectedVersion !== 7 || parameters.resolution !== '1080p' || parameters.routingVersionId !== IDS.routingVersion) throw new FixtureInputError('invalid routing simulation'); value = reply({ candidates: [{ costPoints: '1000', marginBps: 3333, modelCode: 'video_fast', providerName: '星河视频供应商', salePoints: '1500', score: 98.5, scoreExplanation: ['质量优先', '毛利达标'], selected: true }], exclusions: [], requestId: IDS.request, sourceUpdatedAt: timestamp }); }
      else if (path === '/admin/tasks') value = reply({ items: [{ id: IDS.task, providerName: '星河视频供应商', status: 'PROVIDER_PENDING', updatedAt: timestamp, userIdMasked: 'usr_****d2e3f' }], nextCursor: null, partialFields: [], queue: { backlog: 12, concurrencyLimit: 24, defaultPriority: 8, operationPreviews: [], paused: false, rateLimitPerMinute: 600, running: 8, version: 12 }, sourceUpdatedAt: timestamp });
      else if (path === `/admin/tasks/${IDS.task}/raw`) value = reply({ request: { authorization: 'Bearer raw-secret-must-be-redacted', prompt: '海边日落' }, response: { requestId: 'safe-request-id', token: 'raw-token-must-be-redacted' } });
      else if (path === `/admin/tasks/${IDS.task}`) value = reply(taskDetail(actor));
      else if (path === `/v1/admin/users/${IDS.user}/detail`) value = reply(userDetail(state));
      else if (path === `/v1/admin/users/${IDS.user}/authorization-scope`) value = reply({ assignedAdminIds: [IDS.actor], ownerAdminId: IDS.actor, userId: IDS.user });
      else if (path === `/v1/admin/users/${IDS.user}/eligible-approvers`) { const input = exactObject(await body(request), ['scope']); if (input.scope !== 'ALL') throw new FixtureInputError('invalid eligible approver scope'); value = reply([{ displayName: '复核管理员', id: IDS.reviewer }]); }
      else if (path === `/v1/admin/users/${IDS.user}/wallet-adjustment-previews`) { const input = exactObject(await body(request), ['approverId', 'direction', 'points', 'reason']); if (input.approverId !== IDS.reviewer || input.direction !== 'CREDIT' || input.points !== '10' || input.reason !== '活动补偿') throw new FixtureInputError('invalid wallet adjustment preview'); value = reply({ after: '110', before: '100', direction: 'CREDIT', expiresAt: soon, impact: '新增审计分录并等待独立审批', points: '10', policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456' }); }
      else if (path === `/v1/admin/users/${IDS.user}/wallet-adjustment-requests`) { const input = exactObject(await body(request), ['approverId', 'direction', 'points', 'previewToken', 'reason']); if (input.approverId !== IDS.reviewer || input.direction !== 'CREDIT' || input.points !== '10' || input.previewToken !== 'pv_abcdefghijklmnopqrstuvwxyz123456' || input.reason !== '活动补偿' || state.walletAdjustmentRequested) throw new FixtureInputError('invalid wallet adjustment request'); state.walletAdjustmentRequested = true; value = reply({ auditRecordId: IDS.audit, requestId: IDS.request, status: 'PENDING_APPROVAL' }); }
      else if (path === `/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}`) value = state.walletAdjustmentRequested ? reply({ approverId: IDS.reviewer, direction: 'CREDIT', id: IDS.request, points: '10', requestedById: IDS.actor, status: state.walletAdjustmentApproved ? 'APPROVED' : 'PENDING_APPROVAL', userId: IDS.user, version: state.walletAdjustmentApproved ? 2 : 1 }) : reply({ error: 'NOT_FOUND' }, 404);
      else if (path === `/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approval-previews`) { const input = exactObject(await body(request), ['audit', 'expectedVersion', 'reason']); exactHeaderAudit(input, request); if (actor !== IDS.reviewer || input.expectedVersion !== 1 || input.reason !== '独立复核活动补偿' || !state.walletAdjustmentRequested || state.walletAdjustmentApproved) throw new FixtureInputError('invalid wallet approval preview'); value = reply({ expiresAt: soon, impact: '余额 100 → 110，并新增审计流水', preflightToken: 'approval-token-abcdefghijklmnopqrstuvwxyz', resultStatus: 'APPROVED', resultVersion: 2 }); }
      else if (path === `/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approvals`) { const input = exactObject(await body(request), ['audit', 'expectedVersion', 'preflightToken', 'reason']); exactHeaderAudit(input, request); if (actor !== IDS.reviewer || input.expectedVersion !== 1 || input.preflightToken !== 'approval-token-abcdefghijklmnopqrstuvwxyz' || input.reason !== '独立复核活动补偿' || !state.walletAdjustmentRequested || state.walletAdjustmentApproved) throw new FixtureInputError('invalid wallet approval'); calls.walletAdjustmentApprovals += 1; state.walletAdjustmentApproved = true; value = reply({ auditRecordId: IDS.audit, requestId: IDS.request, status: 'APPROVED', userId: IDS.user, version: 2 }); }
      else if (path === '/admin/finance/reconciliation') value = reply({ items: [reconciliation(state)], nextCursor: null, sourceUpdatedAt: timestamp });
      else if (path === `/admin/finance/reconciliation/${IDS.reconciliation}`) value = reply(reconciliation(state));
      else if (path === `/admin/finance/reconciliation/${IDS.reconciliation}/compensation-requests`) { const input = exactObject(await body(request), ['actorId', 'audit', 'confirmed', 'expectedVersion', 'preflightToken', 'requiredApprovals']); exactAudit(input, request, ['修复渠道金额差异', '验证申请人不可自审']); if (input.actorId !== actor || input.confirmed !== true || input.expectedVersion !== 7 || input.preflightToken !== 'recon-preflight-signed-token' || input.requiredApprovals !== 2 || state.compensationCreated) throw new FixtureInputError('invalid compensation request'); state.compensationCreated = true; value = reply({ auditRecordId: IDS.audit, caseId: IDS.reconciliation, compensationRequestId: IDS.compensation, idempotencyKey: input.audit.idempotencyKey, ok: true, operation: 'CREATE_COMPENSATION_REQUEST', requestId: IDS.request, status: 'PENDING_APPROVAL', version: 8 }); }
      else if (path === `/admin/finance/reconciliation/${IDS.reconciliation}/compensation-requests/${IDS.compensation}/approvals`) { const input = exactObject(await body(request), ['actorId', 'approverId', 'audit', 'confirmed', 'expectedVersion', 'preflightToken']); exactAudit(input, request, '账本与渠道凭据一致'); if (input.actorId !== actor || input.approverId !== actor || input.confirmed !== true || input.expectedVersion !== 8 || input.preflightToken !== 'recon-approval-signed-token' || !state.compensationCreated || state.compensationApproved) throw new FixtureInputError('invalid compensation approval'); calls.compensationApprovals += 1; state.compensationApproved = true; value = reply({ auditRecordId: IDS.audit, caseId: IDS.reconciliation, compensationRequestId: IDS.compensation, idempotencyKey: input.audit.idempotencyKey, ok: true, operation: 'APPROVE_COMPENSATION_REQUEST', requestId: IDS.request, status: 'APPROVED', version: 9 }); }
      else if (path === '/admin/finance/ledger') value = reply({ items: [{ businessKey: 'reconciliation:balance:001', createdAt: timestamp, entries: [{ account: 'USER_AVAILABLE', credit: '0', debit: '800', id: IDS.entry }, { account: 'PLATFORM_LIABILITY', credit: '800', debit: '0', id: IDS.transaction }], id: IDS.transaction, traceId: '2123456789abcdef0123456789abcdef' }], nextCursor: null, sourceUpdatedAt: timestamp, totals: { credit: '800', debit: '800' } });
      else if (path === '/admin/finance/orders') value = reply({ items: [order(actor, state)], nextCursor: null, sourceUpdatedAt: timestamp });
      else if (path === '/admin/content') value = reply({ items: [contentItem(state)], nextCursor: null, sourceUpdatedAt: timestamp });
      else if (path === `/admin/content/${IDS.content}`) value = reply(contentItem(state));
      else if (path === `/admin/content/${IDS.content}/operations`) { const input = exactObject(await body(request), ['actorId', 'audit', 'confirmed', 'expectedVersion', 'operation', 'preflightToken']); exactAudit(input, request, ['发布维护窗口公告', '验证重复发布保护']); if (input.actorId !== actor || input.confirmed !== true || input.expectedVersion !== 3 || input.operation !== 'PUBLISH' || input.preflightToken !== 'content-preview-signed-token' || state.contentPublished) throw new FixtureInputError('invalid content publish'); calls.contentOperations += 1; state.contentPublished = true; value = reply({ auditRecordId: IDS.audit, contentId: IDS.content, idempotencyKey: input.audit.idempotencyKey, ok: true, operation: 'PUBLISH', requestId: IDS.request, status: 'PUBLISHED', version: 4 }); }
      else if (path === '/admin/tickets') value = reply({ items: [ticketItem(state)], nextCursor: null, sourceUpdatedAt: timestamp });
      else if (path === `/admin/tickets/${IDS.ticket}`) value = reply(ticketItem(state));
      else if (path === `/admin/tickets/${IDS.ticket}/transitions`) { const input = exactObject(await body(request), ['actorId', 'audit', 'confirmed', 'expectedStatus', 'expectedVersion', 'preflightToken', 'to']); exactAudit(input, request, '问题已验证解决'); if (input.actorId !== actor || input.confirmed !== true || input.expectedStatus !== 'IN_PROGRESS' || input.expectedVersion !== 5 || input.preflightToken !== 'ticket-resolve-preflight' || input.to !== 'RESOLVED' || state.ticketResolved) throw new FixtureInputError('invalid ticket transition'); state.ticketResolved = true; value = reply({ auditRecordId: IDS.audit, idempotencyKey: input.audit.idempotencyKey, ok: true, operation: 'TRANSITION', requestId: IDS.request, status: 'RESOLVED', ticketId: IDS.ticket, version: 6 }); }
      else if (path === '/admin/iam') value = reply(iam(actor));
      else { console.error(`[admin-web e2e fixture] unexpected ${request.method} ${path}`); value = reply({ error: 'UNEXPECTED_FIXTURE_REQUEST', method: request.method, path }, 500); }
      send(response, value);
    } catch (error) { if (!(error instanceof FixtureInputError)) console.error(error); send(response, reply({ error: error instanceof FixtureInputError ? 'INVALID_FIXTURE_INPUT' : 'FIXTURE_FAILURE' }, error instanceof FixtureInputError ? 400 : 500)); }
  };
}

export { IDS };
