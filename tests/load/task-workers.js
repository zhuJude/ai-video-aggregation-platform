import http from 'k6/http';
import { check } from 'k6';

const baseUrl = __ENV.BASE_URL || 'http://host.docker.internal:3102';

export const options = {
  scenarios: {
    asynchronous_tasks: { executor: 'constant-vus', vus: 200, duration: __ENV.DURATION || '10m' },
  },
  thresholds: {
    'http_req_duration{name:task-accept}': ['p(95)<2000'],
    http_req_failed: ['rate<0.005'],
  },
};

export default function () {
  const idempotencyKey = `00000000-0000-7000-8000-${String(__VU).padStart(4, '0')}${String(__ITER % 100000000).padStart(8, '0')}`;
  const response = http.post(`${baseUrl}/v1/tasks`, JSON.stringify({ loadTest: true }), {
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    tags: { name: 'task-accept' },
  });
  check(response, { 'task accepted without server error': (r) => r.status < 500 });
}
