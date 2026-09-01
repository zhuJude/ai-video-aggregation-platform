import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedSource = join(serviceRoot, 'src', 'generated', 'prisma');
const generatedDist = join(serviceRoot, 'dist', 'src', 'generated', 'prisma');

if (!existsSync(generatedSource)) throw new Error('PRISMA_CLIENT_NOT_GENERATED');
rmSync(generatedDist, { recursive: true, force: true });
mkdirSync(dirname(generatedDist), { recursive: true });
cpSync(generatedSource, generatedDist, { recursive: true });
