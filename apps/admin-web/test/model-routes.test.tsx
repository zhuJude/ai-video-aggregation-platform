/* eslint-disable @typescript-eslint/require-await -- async fakes model protected route ports. */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ModelsLoading from '../app/(secure)/models/loading';
import { renderModelsPage } from '../app/(secure)/models/page';
import { renderModelCapabilitiesPage } from '../app/(secure)/models/[id]/capabilities/page';
import { signAdminSession } from '../lib/session-auth';

const modelId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const providerId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const versionId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const sessionId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const signingKey = 'model-routes-test-signing-key-at-least-32-bytes';
const definition = {
  costDimensions: [],
  providerMapping: { prompt: 'prompt' },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
    type: 'object',
  },
  uiSchema: { fields: [{ label: '提示词', name: 'prompt', order: 1 }] },
} as const;

async function context() {
  const sessionToken = await signAdminSession(
    {
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
      permissions: ['models:read', 'models:write'],
      sessionInstanceId: sessionId,
      subjectId: actorId,
    },
    signingKey,
  );
  return { sessionToken, signingKey };
}

describe('model routes', () => {
  it('renders accessible loading, empty and partial directory states', async () => {
    const { rerender } = render(<ModelsLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('正在载入模型能力目录');
    rerender(
      await renderModelsPage({
        context: await context(),
        port: {
          async listModels() {
            return { items: [], partialFields: [], sourceUpdatedAt: '2026-08-28T00:00:00.000Z' };
          },
        },
      }),
    );
    expect(screen.getByText('当前数据范围内暂无模型')).toBeVisible();
    rerender(
      await renderModelsPage({
        context: await context(),
        port: {
          async listModels() {
            return {
              items: [
                {
                  assignedAdminIds: [actorId],
                  code: 'mock-video-v1',
                  displayName: 'Mock Video',
                  draftVersion: 2,
                  id: modelId,
                  ownerAdminId: actorId,
                  providerId,
                  providerName: 'Mock Provider',
                  publishedVersion: null,
                  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
                  status: 'DRAFT',
                },
              ],
              partialFields: ['publishedVersion'],
              sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
            };
          },
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('publishedVersion');
    expect(screen.getByRole('link', { name: /Mock Video/ })).toHaveAttribute(
      'href',
      `/models/${modelId}/capabilities`,
    );
  });

  it('renders the capability editor only after server authorization and scope checks', async () => {
    const route = await renderModelCapabilitiesPage(modelId, {
      context: await context(),
      port: {
        async getCapability() {
          return {
            assignedAdminIds: [actorId],
            definition,
            history: [],
            model: { code: 'mock-video-v1', displayName: 'Mock Video', id: modelId, providerId },
            ownerAdminId: actorId,
            publishedDefinition: null,
            sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
            status: 'DRAFT',
            version: 1,
            versionId,
          };
        },
      },
    });
    render(route);
    expect(screen.getByRole('heading', { name: /Mock Video · 能力版本 1/ })).toBeVisible();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '发布' })).not.toBeInTheDocument();
  });
});
