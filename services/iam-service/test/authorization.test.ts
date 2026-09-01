import { describe, expect, it } from 'vitest';

import { can, mergeDataScopes } from '../src/domain/authorization.js';

describe('deterministic IAM authorization', () => {
  const resource = {
    ownerAdminId: '0198fabc-1234-7abc-8abc-000000000301',
    assignedAdminIds: ['0198fabc-1234-7abc-8abc-000000000302'],
  };

  it('requires a matching permission and explicit data-scope context', () => {
    const owner = {
      adminId: resource.ownerAdminId,
      grants: [{ permission: 'users:read', dataScope: 'OWN' as const }],
    };
    expect(can(owner, 'users:read', resource)).toBe(true);
    expect(can(owner, 'users:read', { ...resource, ownerAdminId: 'someone-else' })).toBe(false);
    expect(can(owner, 'wallet:adjust', resource)).toBe(false);
  });

  it('merges repeated scopes by union while ALL dominates', () => {
    const assignedAdminId = resource.assignedAdminIds[0] ?? '';
    const subject = {
      adminId: assignedAdminId,
      grants: [
        { permission: 'users:read', dataScope: 'OWN' as const },
        { permission: 'users:read', dataScope: 'ASSIGNED' as const },
      ],
    };
    expect(mergeDataScopes(subject.grants, 'users:read')).toEqual(['OWN', 'ASSIGNED']);
    expect(can(subject, 'users:read', resource)).toBe(true);
    expect(
      mergeDataScopes(
        [...subject.grants, { permission: 'users:read', dataScope: 'ALL' as const }],
        'users:read',
      ),
    ).toEqual(['ALL']);
  });

  it('defaults to deny for malformed subjects, permissions, and resource context', () => {
    expect(can({ adminId: '', grants: [] }, 'users:read', resource)).toBe(false);
    expect(can({ adminId: 'a1', grants: [] }, '', resource)).toBe(false);
    expect(can({ adminId: 'a1', grants: [] }, 'users:read', null as never)).toBe(false);
  });
});
