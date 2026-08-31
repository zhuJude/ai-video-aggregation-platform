import { log } from 'node:console';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compiledClientPath = join(serviceRoot, 'dist', 'src', 'generated', 'prisma', 'index.js');
const clientModule = /** @type {unknown} */ (await import(pathToFileURL(compiledClientPath).href));
const moduleRecord = /** @type {Record<string, unknown>} */ (clientModule);
const defaultExport = moduleRecord['default'];
const defaultRecord =
  typeof defaultExport === 'object' && defaultExport !== null
    ? /** @type {Record<string, unknown>} */ (defaultExport)
    : undefined;
const PrismaClient = moduleRecord['PrismaClient'] ?? defaultRecord?.['PrismaClient'];

if (typeof PrismaClient !== 'function') {
  throw new Error('PRISMA_CLIENT_CONSTRUCTOR_UNAVAILABLE');
}

const adapter = new PrismaPg({
  connectionString: 'postgresql://identity_build:identity_build@127.0.0.1:5432/identity_build',
});
const constructedClient = /** @type {unknown} */ (Reflect.construct(PrismaClient, [{ adapter }]));
const client = /** @type {{ $disconnect(): Promise<void> }} */ (constructedClient);

await client.$disconnect();
log('Prisma compiled runtime probe passed.');
