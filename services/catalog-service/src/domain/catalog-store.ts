import { Injectable } from '@nestjs/common';
import type { CapabilityDocument } from '@repo/capability-schema';
import {
  createDraft,
  publish,
  type CapabilityStatus,
  type CapabilityVersion,
} from './capability-publication.js';

export type ProviderStatus = 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
export type ModelStatus = 'DRAFT' | 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
export type GenerationMode =
  'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | 'FIRST_LAST_FRAME' | 'REFERENCE_VIDEO' | 'EXTEND_VIDEO';

export interface CatalogProvider {
  id: string;
  code: string;
  displayName: string;
  status: ProviderStatus;
  credentialRefs: string[];
  maintenanceStartsAt?: string;
  maintenanceEndsAt?: string;
}

export interface CatalogModel {
  id: string;
  providerId: string;
  code: string;
  providerModelId: string;
  displayName: string;
  modes: GenerationMode[];
  status: ModelStatus;
  sortOrder: number;
  capabilityVersionId: string | null;
  capabilityStatus: CapabilityStatus | null;
  maintenanceStartsAt?: string;
  maintenanceEndsAt?: string;
}

export interface CreateCapabilityInput {
  id: string;
  version: number;
  document: CapabilityDocument;
}

export interface PublicModel {
  id: string;
  providerId: string;
  providerCode: string;
  providerDisplayName: string;
  code: string;
  displayName: string;
  modes: GenerationMode[];
  status: 'ACTIVE';
  sortOrder: number;
  capabilityVersionId: string;
}

function catalogError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

@Injectable()
export class CatalogStore {
  private readonly providers = new Map<string, CatalogProvider>();
  private readonly models = new Map<string, CatalogModel>();
  private readonly capabilities = new Map<string, CapabilityVersion>();
  private readonly retiredCapabilities = new Set<string>();

  seedProvider(provider: CatalogProvider): void {
    this.providers.set(provider.id, structuredClone(provider));
  }

  seedModel(model: CatalogModel): void {
    this.models.set(model.id, structuredClone(model));
  }

  createProvider(provider: CatalogProvider): CatalogProvider {
    if ([...this.providers.values()].some((current) => current.code === provider.code)) {
      throw catalogError('PROVIDER_CODE_CONFLICT');
    }
    this.seedProvider(provider);
    return structuredClone(provider);
  }

  createModel(model: CatalogModel): CatalogModel {
    if (!this.providers.has(model.providerId)) throw catalogError('PROVIDER_NOT_FOUND');
    if (
      [...this.models.values()].some(
        (current) => current.providerId === model.providerId && current.code === model.code,
      )
    ) {
      throw catalogError('MODEL_CODE_CONFLICT');
    }
    this.seedModel(model);
    return structuredClone(model);
  }

  updateModel(
    id: string,
    changes: Partial<
      Pick<
        CatalogModel,
        'displayName' | 'status' | 'sortOrder' | 'maintenanceStartsAt' | 'maintenanceEndsAt'
      >
    >,
  ): CatalogModel {
    const existing = this.models.get(id);
    if (!existing) throw catalogError('MODEL_NOT_FOUND');
    const updated = { ...existing, ...changes };
    this.models.set(id, updated);
    return structuredClone(updated);
  }

  createCapability(modelId: string, input: CreateCapabilityInput): CapabilityVersion {
    const model = this.models.get(modelId);
    if (!model) throw catalogError('MODEL_NOT_FOUND');
    if (
      [...this.capabilities.values()].some(
        (current) => current.modelId === modelId && current.version === input.version,
      )
    ) {
      throw catalogError('CAPABILITY_VERSION_CONFLICT');
    }
    const draft = createDraft({ ...input, modelId });
    this.capabilities.set(input.id, draft);
    return structuredClone(draft);
  }

  publishCapability(id: string, publishedBy: string): CapabilityVersion {
    const draft = this.capabilities.get(id);
    if (!draft) throw catalogError('CAPABILITY_NOT_FOUND');
    const result = publish(draft, publishedBy);
    this.capabilities.set(id, result.capability);
    const model = this.models.get(result.capability.modelId);
    if (!model) throw catalogError('MODEL_NOT_FOUND');
    this.models.set(model.id, {
      ...model,
      capabilityVersionId: id,
      capabilityStatus: 'PUBLISHED',
    });
    return structuredClone(result.capability);
  }

  retireCapability(id: string): CapabilityVersion {
    const capability = this.capabilities.get(id);
    if (!capability) throw catalogError('CAPABILITY_NOT_FOUND');
    if (capability.status !== 'PUBLISHED') throw catalogError('CAPABILITY_NOT_PUBLISHED');
    this.retiredCapabilities.add(id);
    const model = this.models.get(capability.modelId);
    if (model?.capabilityVersionId === id) {
      this.models.set(model.id, { ...model, capabilityStatus: 'RETIRED' });
    }
    return { ...structuredClone(capability), status: 'RETIRED' };
  }

  listPublicModels(): PublicModel[] {
    return [...this.models.values()]
      .filter(
        (model) =>
          model.status === 'ACTIVE' &&
          model.capabilityStatus === 'PUBLISHED' &&
          model.capabilityVersionId !== null &&
          !this.retiredCapabilities.has(model.capabilityVersionId) &&
          this.providers.get(model.providerId)?.status === 'ACTIVE',
      )
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
      .map((model) => {
        const provider = this.providers.get(model.providerId);
        if (!provider || model.capabilityVersionId === null) {
          throw catalogError('CATALOG_PUBLICATION_INCONSISTENT');
        }
        return {
          id: model.id,
          providerId: provider.id,
          providerCode: provider.code,
          providerDisplayName: provider.displayName,
          code: model.code,
          displayName: model.displayName,
          modes: [...model.modes],
          status: 'ACTIVE',
          sortOrder: model.sortOrder,
          capabilityVersionId: model.capabilityVersionId,
        };
      });
  }

  getPublishedCapability(id: string): CapabilityVersion | undefined {
    const capability = this.capabilities.get(id);
    if (!capability || capability.status !== 'PUBLISHED' || this.retiredCapabilities.has(id)) {
      return undefined;
    }
    return structuredClone(capability);
  }
}
