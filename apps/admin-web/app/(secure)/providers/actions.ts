'use server';

import { createHttpProviderOperationPorts } from '../../../lib/http-provider-operation-port';
import {
  createProviderCommandAction,
  createProviderMetadataAction,
} from '../../../lib/provider-operations';

export async function executeProviderCommandAction(formData: FormData) {
  const ports = createHttpProviderOperationPorts();
  return createProviderCommandAction({
    detailPort: ports.detailPort,
    port: ports.commandPort,
  })(formData);
}

export async function writeProviderMetadataAction(formData: FormData) {
  const ports = createHttpProviderOperationPorts();
  return createProviderMetadataAction({
    detailPort: ports.detailPort,
    port: ports.metadataPort,
  })(formData);
}
