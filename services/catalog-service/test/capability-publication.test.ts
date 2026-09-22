import { describe, expect, it } from 'vitest';
import {
  CapabilityPublicationService,
  createDraft,
  editPublished,
  publish,
  type CapabilityPublicationTransaction,
  type CapabilityDraftInput,
} from '../src/domain/capability-publication.js';

const validDocument: CapabilityDraftInput['document'] = {
  schemaVersion: 1,
  mode: 'IMAGE_TO_VIDEO',
  jsonSchema: {
    type: 'object',
    required: ['image', 'duration'],
    properties: {
      image: { type: 'string', format: 'asset-id' },
      duration: { type: 'integer', enum: [5, 10] },
    },
  },
  uiSchema: {
    order: ['image', 'duration'],
    groups: [{ key: 'basic', title: '基础', fields: ['image', 'duration'] }],
  },
  costDimensions: ['duration'],
};

function draftInput(
  document: CapabilityDraftInput['document'] = validDocument,
): CapabilityDraftInput {
  return {
    id: '01999d31-f7a3-7c50-98ae-04a08e875495',
    modelId: '01999d31-f7a3-7c50-98ae-04a08e875496',
    version: 1,
    document,
  };
}

describe('capability publication', () => {
  it('publishes an immutable version instead of editing the active version', () => {
    const draft = createDraft(draftInput());
    const result = publish(draft, '01999d31-f7a3-7c50-98ae-04a08e875497');

    expect(result.capability.status).toBe('PUBLISHED');
    expect(result.capability.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => editPublished(result.capability, {})).toThrow('CAPABILITY_VERSION_IMMUTABLE');
  });

  it('rejects a document that is not a canonical capability document', () => {
    const invalid = { ...validDocument, schemaVersion: 0 };

    expect(() => publish(createDraft(draftInput(invalid)), 'admin-1')).toThrow(
      'CAPABILITY_DOCUMENT_INVALID',
    );
  });

  it('rejects an invalid JSON Schema before publication', () => {
    const invalid = {
      ...validDocument,
      jsonSchema: {
        ...validDocument.jsonSchema,
        properties: { duration: { type: 'not-a-json-schema-type' } },
      },
    };

    expect(() => publish(createDraft(draftInput(invalid)), 'admin-1')).toThrow(
      'CAPABILITY_JSON_SCHEMA_INVALID',
    );
  });

  it.each([
    ['UI order', { ...validDocument.uiSchema, order: ['missing'] }, ['duration']],
    [
      'UI group',
      {
        ...validDocument.uiSchema,
        groups: [{ key: 'basic', title: '基础', fields: ['missing'] }],
      },
      ['duration'],
    ],
    ['cost dimension', validDocument.uiSchema, ['missing']],
  ])('rejects an unknown %s field reference', (_label, uiSchema, costDimensions) => {
    const invalid = { ...validDocument, uiSchema, costDimensions };

    expect(() => publish(createDraft(draftInput(invalid)), 'admin-1')).toThrow(
      'CAPABILITY_FIELD_REFERENCE_INVALID',
    );
  });

  it('creates publication and outbox records for the same capability version', () => {
    const result = publish(
      createDraft(draftInput()),
      '01999d31-f7a3-7c50-98ae-04a08e875497',
      new Date('2026-08-31T00:00:00.000Z'),
    );

    expect(result.publication.capabilityVersionId).toBe(result.capability.id);
    expect(result.outbox.aggregateId).toBe(result.capability.id);
    expect(result.outbox.eventType).toBe('catalog.capability-published.v1');
    expect(result.outbox.payload).toMatchObject({
      capabilityVersionId: result.capability.id,
      modelId: result.capability.modelId,
      version: 1,
    });
  });

  it('persists the published version and outbox in one transaction', async () => {
    const writes: string[] = [];
    const transaction: CapabilityPublicationTransaction = {
      updateCapability: () => {
        writes.push('capability');
        return Promise.resolve();
      },
      insertPublication: () => {
        writes.push('publication');
        return Promise.resolve();
      },
      insertOutbox: () => {
        writes.push('outbox');
        return Promise.resolve();
      },
    };
    let transactionCount = 0;
    const service = new CapabilityPublicationService({
      transaction: async (work) => {
        transactionCount += 1;
        return work(transaction);
      },
    });

    await service.publish(createDraft(draftInput()), 'admin-1');

    expect(transactionCount).toBe(1);
    expect(writes).toEqual(['capability', 'publication', 'outbox']);
  });
});
