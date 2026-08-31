import { describe, expect, it } from 'vitest';
import { CapabilityDocumentSchema } from '../src/index.js';

describe('CapabilityDocument', () => {
  it('validates a versioned image-to-video capability', () => {
    const value = CapabilityDocumentSchema.parse({
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
        groups: [
          {
            key: 'basic',
            title: '基础',
            fields: ['image', 'duration'],
          },
        ],
      },
      costDimensions: ['duration'],
    });
    expect(value.costDimensions).toEqual(['duration']);
  });
});
