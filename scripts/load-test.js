import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },      // Ramp-up to 20 virtual users over 30s
    { duration: '1m', target: 20 },       // Stay at 20 virtual users for 1m
    { duration: '10s', target: 0 },       // Ramp-down to 0 virtual users over 10s
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],   // http errors should be less than 1%
    http_req_duration: ['p(95)<200'], // 95% of requests should be below 200ms
  },
};

export default function () {
  const res = http.get('http://localhost:8080/stats');
  check(res, { 'status was 200': (r) => r.status == 200 });

  const metricsRes = http.get('http://localhost:8080/metrics');
  check(metricsRes, { 'metrics status was 200': (r) => r.status == 200 });

  sleep(1);
}
