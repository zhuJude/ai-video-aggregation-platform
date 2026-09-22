import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? '8080');
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://local-support.invalid');
  if (request.method === 'GET' && ['/ready', '/consumer', '/health/ready'].includes(url.pathname)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready', adapter: 'local' }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/jwks') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [] }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/publish') {
    request.resume();
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ accepted: true }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/callbacks/provider') {
    request.resume();
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ accepted: true }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'NOT_FOUND' }));
});

server.listen(port, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
