import { createQuoteRoutingApplication } from './app.js';

const { app } = await createQuoteRoutingApplication();
const port = Number.parseInt(process.env.PORT ?? '3002', 10);
await app.listen(port, '0.0.0.0');
