import { createHash, randomUUID } from 'node:crypto';
import { CapabilityDocumentSchema, type CapabilityDocument } from '@repo/capability-schema';
import { Ajv2020 } from 'ajv/dist/2020.js';

export type CapabilityStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export interface CapabilityDraftInput {
  id: string;
  modelId: string;
  version: number;
  document: CapabilityDocument;
}

export interface CapabilityVersion {
  id: string;
  modelId: string;
  version: number;
  status: CapabilityStatus;
  document: CapabilityDocument;
  contentSha256: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
}

export interface CapabilityPublication {
  id: string;
  capabilityVersionId: string;
  publishedAt: Date;
  publishedBy: string;
  contentSha256: string;
}

export interface CapabilityPublishedOutbox {
  id: string;
  aggregateId: string;
  eventType: 'catalog.capability-published.v1';
  occurredAt: string;
  payload: {
    capabilityVersionId: string;
    modelId: string;
    version: number;
    contentSha256: string;
  };
}

export interface CapabilityPublicationResult {
  capability: Readonly<CapabilityVersion>;
  publication: Readonly<CapabilityPublication>;
  outbox: Readonly<CapabilityPublishedOutbox>;
}

export interface CapabilityPublicationTransaction {
  updateCapability(capability: Readonly<CapabilityVersion>): Promise<void>;
  insertPublication(publication: Readonly<CapabilityPublication>): Promise<void>;
  insertOutbox(outbox: Readonly<CapabilityPublishedOutbox>): Promise<void>;
}

export interface CapabilityPublicationUnitOfWork {
  transaction<T>(work: (transaction: CapabilityPublicationTransaction) => Promise<T>): Promise<T>;
}

function codedError(code: string, cause?: unknown): Error & { code: string; cause?: unknown } {
  return Object.assign(new Error(code), { code, ...(cause === undefined ? {} : { cause }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function parseCapabilityDocument(document: unknown): CapabilityDocument {
  const parsed = CapabilityDocumentSchema.safeParse(document);
  if (!parsed.success) throw codedError('CAPABILITY_DOCUMENT_INVALID', parsed.error);
  return parsed.data;
}

function validateJsonSchema(document: CapabilityDocument): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('asset-id', true);
  try {
    ajv.compile(document.jsonSchema);
  } catch (error) {
    throw codedError('CAPABILITY_JSON_SCHEMA_INVALID', error);
  }
}

function validateFieldReferences(document: CapabilityDocument): void {
  const propertiesValue = document.jsonSchema.properties;
  const properties = isRecord(propertiesValue) ? new Set(Object.keys(propertiesValue)) : new Set();
  const references = [
    ...document.uiSchema.order,
    ...document.uiSchema.groups.flatMap((group) => group.fields),
    ...document.costDimensions,
  ];
  if (references.some((field) => !properties.has(field))) {
    throw codedError('CAPABILITY_FIELD_REFERENCE_INVALID');
  }
}

export function assertEditable(status: CapabilityStatus): void {
  if (status !== 'DRAFT') throw codedError('CAPABILITY_VERSION_IMMUTABLE');
}

export function createDraft(input: CapabilityDraftInput): CapabilityVersion {
  if (!Number.isInteger(input.version) || input.version <= 0) {
    throw codedError('CAPABILITY_VERSION_INVALID');
  }
  return {
    ...input,
    status: 'DRAFT',
    contentSha256: null,
    publishedAt: null,
    publishedBy: null,
  };
}

export function editPublished(
  capability: CapabilityVersion,
  changes: Partial<CapabilityDraftInput>,
): never {
  void changes;
  assertEditable(capability.status);
  throw codedError('CAPABILITY_VERSION_IMMUTABLE');
}

export function publish(
  draft: CapabilityVersion,
  publishedBy: string,
  publishedAt = new Date(),
): CapabilityPublicationResult {
  assertEditable(draft.status);
  const document = parseCapabilityDocument(draft.document);
  validateJsonSchema(document);
  validateFieldReferences(document);
  const contentSha256 = createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
  const capability = deepFreeze({
    ...draft,
    document,
    status: 'PUBLISHED' as const,
    contentSha256,
    publishedAt,
    publishedBy,
  });
  const publication = deepFreeze({
    id: randomUUID(),
    capabilityVersionId: capability.id,
    publishedAt,
    publishedBy,
    contentSha256,
  });
  const outbox = deepFreeze({
    id: randomUUID(),
    aggregateId: capability.id,
    eventType: 'catalog.capability-published.v1' as const,
    occurredAt: publishedAt.toISOString(),
    payload: {
      capabilityVersionId: capability.id,
      modelId: capability.modelId,
      version: capability.version,
      contentSha256,
    },
  });
  return deepFreeze({ capability, publication, outbox });
}

export class CapabilityPublicationService {
  constructor(private readonly unitOfWork: CapabilityPublicationUnitOfWork) {}

  async publish(
    draft: CapabilityVersion,
    publishedBy: string,
    publishedAt = new Date(),
  ): Promise<CapabilityPublicationResult> {
    const result = publish(draft, publishedBy, publishedAt);
    return this.unitOfWork.transaction(async (transaction) => {
      await transaction.updateCapability(result.capability);
      await transaction.insertPublication(result.publication);
      await transaction.insertOutbox(result.outbox);
      return result;
    });
  }
}
