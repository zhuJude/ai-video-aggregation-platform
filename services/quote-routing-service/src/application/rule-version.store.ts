import { Injectable } from '@nestjs/common';

export type RuleKind = 'PRICE' | 'ROUTE';
export type RuleVersionStatus = 'DRAFT' | 'PUBLISHED';

export interface RuleVersion {
  id: string;
  kind: RuleKind;
  version: number;
  status: RuleVersionStatus;
  effectiveAt: string;
  payload: Record<string, unknown>;
  publishedAt?: string;
  publishedBy?: string;
  rollbackOfVersion?: number;
}

function ruleError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

@Injectable()
export class RuleVersionStore {
  private readonly rules: RuleVersion[] = [];

  createDraft(
    kind: RuleKind,
    input: Pick<RuleVersion, 'id' | 'version' | 'effectiveAt' | 'payload'>,
  ): RuleVersion {
    if (!Number.isInteger(input.version) || input.version <= 0) {
      throw ruleError('RULE_VERSION_INVALID');
    }
    if (this.rules.some((rule) => rule.kind === kind && rule.version === input.version)) {
      throw ruleError('RULE_VERSION_CONFLICT');
    }
    const draft: RuleVersion = { ...structuredClone(input), kind, status: 'DRAFT' };
    this.rules.push(draft);
    return structuredClone(draft);
  }

  publish(kind: RuleKind, version: number, publishedBy: string, at = new Date()): RuleVersion {
    const index = this.rules.findIndex((rule) => rule.kind === kind && rule.version === version);
    const draft = this.rules[index];
    if (!draft) throw ruleError('RULE_VERSION_NOT_FOUND');
    if (draft.status !== 'DRAFT') throw ruleError('RULE_VERSION_IMMUTABLE');
    const published: RuleVersion = {
      ...draft,
      status: 'PUBLISHED',
      publishedAt: at.toISOString(),
      publishedBy,
    };
    this.rules[index] = published;
    return structuredClone(published);
  }

  rollback(
    kind: RuleKind,
    targetVersion: number,
    input: { id: string; effectiveAt: string; publishedBy: string },
    at = new Date(),
  ): RuleVersion {
    const target = this.rules.find(
      (rule) => rule.kind === kind && rule.version === targetVersion && rule.status === 'PUBLISHED',
    );
    if (!target) throw ruleError('PUBLISHED_RULE_VERSION_NOT_FOUND');
    const nextVersion =
      this.rules
        .filter((rule) => rule.kind === kind)
        .reduce((maximum, rule) => Math.max(maximum, rule.version), 0) + 1;
    const rollback: RuleVersion = {
      id: input.id,
      kind,
      version: nextVersion,
      status: 'PUBLISHED',
      effectiveAt: input.effectiveAt,
      payload: structuredClone(target.payload),
      publishedAt: at.toISOString(),
      publishedBy: input.publishedBy,
      rollbackOfVersion: target.version,
    };
    this.rules.push(rollback);
    return structuredClone(rollback);
  }
}
