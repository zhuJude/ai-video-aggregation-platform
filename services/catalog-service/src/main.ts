import { createCatalogApplication } from './app.js';

const { app } = await createCatalogApplication({
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? '',
});
const port = Number.parseInt(process.env.PORT ?? '3001', 10);
await app.listen(port, '0.0.0.0');
