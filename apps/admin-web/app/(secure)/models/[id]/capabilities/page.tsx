import { SchemaEditor } from '../../../../../components/capabilities/schema-editor';
import { createHttpModelCapabilityPorts } from '../../../../../lib/http-model-capability-port';
import {
  loadModelCapabilityView,
  type ModelCapabilityPort,
} from '../../../../../lib/model-capability-operations';
import type { ServerGuardContext } from '../../../../../lib/server-guard';
import {
  createCapabilityDraftAction,
  publishCapabilityAction,
  rollbackCapabilityAction,
  saveCapabilityAction,
  validateCapabilityAction,
} from '../../actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderModelCapabilitiesPage(
  modelId: string,
  dependencies: Readonly<{ context?: ServerGuardContext; port: ModelCapabilityPort }>,
) {
  const view = await loadModelCapabilityView(modelId, dependencies);
  return (
    <SchemaEditor
      initial={view.capability}
      onCreateDraft={createCapabilityDraftAction}
      onPublish={publishCapabilityAction}
      onRollback={rollbackCapabilityAction}
      onSave={saveCapabilityAction}
      onValidate={validateCapabilityAction}
      permissions={view.permissions}
    />
  );
}

export default async function ModelCapabilitiesPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return renderModelCapabilitiesPage(id, { port: createHttpModelCapabilityPorts().detailPort });
}
