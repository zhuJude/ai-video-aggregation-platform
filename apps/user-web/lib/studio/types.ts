import type { CapabilityDocument } from '@repo/capability-schema';

export type StudioGenerationMode = CapabilityDocument['mode'];

export type JsonSchemaValue = string | number | boolean | null;

export interface StudioJsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly $defs?: Readonly<Record<string, StudioJsonSchema>>;
  readonly $ref?: string;
  readonly type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'null';
  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly properties?: Readonly<Record<string, StudioJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | StudioJsonSchema;
  readonly enum?: readonly JsonSchemaValue[];
  readonly const?: JsonSchemaValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly allOf?: readonly StudioJsonSchema[];
  readonly anyOf?: readonly StudioJsonSchema[];
  readonly oneOf?: readonly StudioJsonSchema[];
  readonly not?: StudioJsonSchema;
  readonly if?: StudioJsonSchema;
  readonly then?: StudioJsonSchema;
  readonly else?: StudioJsonSchema;
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly items?: StudioJsonSchema | readonly StudioJsonSchema[];
  readonly [keyword: string]: unknown;
}

export type StudioFieldWidget = 'string' | 'textarea' | 'integer' | 'boolean' | 'enum' | 'asset-id';

export interface StudioUiField {
  readonly label?: string;
  readonly widget?: StudioFieldWidget;
  readonly help?: string;
  readonly placeholder?: string;
  readonly unit?: string;
  readonly options?: readonly { readonly value: JsonSchemaValue; readonly label: string }[];
}

export interface StudioVisibilityCondition {
  readonly field: string;
  readonly when: {
    readonly field: string;
    readonly equals?: JsonSchemaValue;
    readonly notEquals?: JsonSchemaValue;
    readonly in?: readonly JsonSchemaValue[];
  };
}

export interface StudioUiSchema {
  readonly order: readonly string[];
  readonly groups: readonly {
    readonly key: string;
    readonly title: string;
    readonly fields: readonly string[];
  }[];
  readonly fields?: Readonly<Record<string, StudioUiField>>;
  readonly conditions?: readonly StudioVisibilityCondition[];
}

export interface StudioCapabilityDocument extends Omit<
  CapabilityDocument,
  'jsonSchema' | 'uiSchema'
> {
  readonly capabilityVersion: string;
  readonly jsonSchema: StudioJsonSchema;
  readonly uiSchema: StudioUiSchema;
}

export interface StudioProviderOption {
  readonly id: string;
  readonly name: string;
}

export interface StudioModelOption {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
  readonly capabilityVersion: string;
}

export interface SmartPreferences {
  readonly generationMode: StudioGenerationMode;
  readonly quality: 'BALANCED' | 'QUALITY_FIRST';
  readonly speed: 'BALANCED' | 'SPEED_FIRST';
  readonly budgetPoints: number;
  readonly goal: string;
}

export interface ProSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly allowEquivalentFallback: boolean;
}

export type StudioRoutingRequest =
  | { readonly kind: 'SMART'; readonly preferences: SmartPreferences }
  | ({ readonly kind: 'EXACT_MODEL' } & ProSelection);

export interface StudioQuoteRequest {
  readonly routing: StudioRoutingRequest;
  readonly capabilityVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface StudioParameterSummaryItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

export interface StudioQuote {
  readonly id: string;
  readonly routing:
    | {
        readonly kind: 'SMART_ROUTING';
        readonly promise: string;
      }
    | {
        readonly kind: 'EXACT_MODEL';
        readonly modelId: string;
        readonly modelName: string;
      };
  readonly capabilityVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly parameterSummary: readonly StudioParameterSummaryItem[];
  readonly quotedPoints: string;
  readonly expiresAt: string;
  readonly failureRefundRule: string;
  readonly cancellationRule: string;
}

export interface StudioCreateTaskRequest {
  readonly quoteId: string;
  readonly capabilityVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly quotedPoints: string;
}

export interface StudioTaskAccepted {
  readonly taskId: string;
  readonly status: 'QUEUED';
}

export interface StudioGateway {
  listProviders(): Promise<readonly StudioProviderOption[]>;
  listModels(): Promise<readonly StudioModelOption[]>;
  getCapability(modelId: string): Promise<StudioCapabilityDocument>;
  getSmartCapability(mode: StudioGenerationMode): Promise<StudioCapabilityDocument>;
  quote(request: StudioQuoteRequest): Promise<StudioQuote>;
  createTask(
    request: StudioCreateTaskRequest,
    options: { readonly idempotencyKey: string },
  ): Promise<StudioTaskAccepted>;
}
