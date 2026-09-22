import type {
  AuditDecisionInput,
  AuditPage,
  AuditQueryInput,
  IamAdministrationRepository,
  ManagementRequestContext,
} from './iam-administration.repository.js';
import { assertUuidV7 } from '../domain/uuid-v7.js';

const SENSITIVE_FIELD =
  /(?:password|secret|token|authorization|cookie|otp|totp|recovery|code|ciphertext|access[_-]?key|private[_-]?key)/i;
const MAX_REDACTION_DEPTH = 16;

export class AuditService {
  constructor(
    private readonly repository: Pick<IamAdministrationRepository, 'appendAudit' | 'queryAudit'>,
    private readonly uuidV7: () => string,
  ) {}

  append(input: Omit<AuditDecisionInput, 'id'>): Promise<void> {
    const id = this.uuidV7();
    assertUuidV7(id, 'INVALID_AUDIT_ID');
    validateManagementContext(input.context);
    return this.repository.appendAudit({
      ...input,
      id,
      before: redactAuditValue(input.before),
      after: redactAuditValue(input.after),
    });
  }

  query(input: AuditQueryInput): Promise<AuditPage> {
    return this.repository.queryAudit(input);
  }
}

export function validateManagementContext(context: ManagementRequestContext): void {
  if (context.actorId !== null) assertUuidV7(context.actorId, 'INVALID_AUDIT_ACTOR_ID');
  assertUuidV7(context.correlationId, 'INVALID_AUDIT_CORRELATION_ID');
  if (context.causationId) assertUuidV7(context.causationId, 'INVALID_AUDIT_CAUSATION_ID');
  if (!/^[0-9a-f]{32}$/.test(context.traceId)) throw stableError('INVALID_AUDIT_TRACE_ID');
  if (!validText(context.ipAddress, 128) || !validText(context.userAgent, 512)) {
    throw stableError('INVALID_AUDIT_CONTEXT');
  }
  if (!(context.occurredAt instanceof Date) || !Number.isFinite(context.occurredAt.getTime())) {
    throw stableError('INVALID_AUDIT_CONTEXT');
  }
}

export function redactAuditValue(value: unknown): unknown {
  return redact(value, 0, new WeakSet<object>());
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'undefined') return '[UNDEFINED]';
  if (typeof value === 'symbol') return value.description ?? '[SYMBOL]';
  if (typeof value === 'function') return '[FUNCTION]';
  if (typeof value !== 'object') return '[UNSUPPORTED]';
  if (depth >= MAX_REDACTION_DEPTH || seen.has(value)) return '[REDACTED]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1, seen));
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redact(entry, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function validText(value: string, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
