import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.BASE_URL || 'http://host.docker.internal:3102';

export const options = {
  scenarios: {
    registered_accounts: {
      executor: 'shared-iterations',
      vus: 200,
      iterations: 10_000,
      maxDuration: '30m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.005'],
    checks: ['rate>0.995'],
  },
};

export default function () {
  const suffix = `${__VU}-${__ITER}`;
  const responses = http.batch([
    ['GET', `${baseUrl}/v1/catalog/models?cursor=&limit=20`, null, { tags: { name: 'catalog' } }],
    [
      'GET',
      `${baseUrl}/v1/wallet`,
      null,
      { headers: { 'x-load-user': suffix }, tags: { name: 'wallet' } },
    ],
    [
      'GET',
      `${baseUrl}/v1/tasks?limit=20`,
      null,
      { headers: { 'x-load-user': suffix }, tags: { name: 'tasks' } },
    ],
  ]);
  for (const response of responses)
    check(response, { 'API status is expected': (r) => r.status < 500 });
  sleep(0.1);
}
