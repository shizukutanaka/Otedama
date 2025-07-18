#!/usr/bin/env node
/*
  Otedama Docker Healthcheck
  Performs internal health validation by requesting the /api/health endpoint (and optionally /metrics).
  Exits with code 0 when healthy, 1 otherwise.
*/
import { setTimeout } from 'node:timers/promises';
import process from 'node:process';


const PORT = process.env.API_PORT || 8080;
const HOST = process.env.HEALTH_HOST || 'localhost';
const base = `http://${HOST}:${PORT}`;

async function checkEndpoint(path) {
  try {
    const res = await fetch(`${base}${path}`, { method: 'GET', headers: { 'User-Agent': 'otedama-healthcheck' }, timeout: 4000 });
    if (!res.ok) return false;
    // For /api/health expect JSON { status: 'ok' }
    if (path === '/api/health') {
      const data = await res.json();
      return data?.status === 'ok';
    }
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const healthyApi = await checkEndpoint('/api/health');
  const healthyMetrics = await checkEndpoint('/metrics');

  if (healthyApi && healthyMetrics) {
    console.log('Otedama healthy');
    process.exit(0);
  }
  console.error('Otedama unhealthy');
  // small delay to ensure log flush
  await setTimeout(100);
  process.exit(1);
})();
