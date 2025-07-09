/**
 * Docker ヘルスチェック
 * コンテナの正常性を確認
 */

import * as http from 'http';
import * as net from 'net';

const HEALTH_CHECK_TIMEOUT = 3000;
const API_PORT = process.env.API_PORT || 3000;
const STRATUM_PORT = process.env.STRATUM_PORT || 3333;

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: number;
  checks: {
    api: boolean;
    stratum: boolean;
    memory: boolean;
    disk: boolean;
  };
}

/**
 * API ヘルスチェック
 */
function checkApiHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: API_PORT,
      path: '/api/health',
      method: 'GET',
      timeout: HEALTH_CHECK_TIMEOUT
    }, (res) => {
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

/**
 * Stratum ヘルスチェック
 */
function checkStratumHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, HEALTH_CHECK_TIMEOUT);

    socket.connect(Number(STRATUM_PORT), 'localhost', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * メモリ使用量チェック
 */
function checkMemoryHealth(): boolean {
  const memUsage = process.memoryUsage();
  const memoryLimitMB = 512; // 512MB制限
  const currentUsageMB = memUsage.heapUsed / 1024 / 1024;
  
  return currentUsageMB < memoryLimitMB;
}

/**
 * ディスク容量チェック（簡易）
 */
function checkDiskHealth(): boolean {
  try {
    const fs = require('fs');
    const stats = fs.statSync('.');
    return true; // 簡易チェック：アクセス可能であればOK
  } catch {
    return false;
  }
}

/**
 * 総合ヘルスチェック実行
 */
async function performHealthCheck(): Promise<HealthStatus> {
  console.log('[Health Check] Starting health check...');
  
  const checks = {
    api: await checkApiHealth(),
    stratum: await checkStratumHealth(),
    memory: checkMemoryHealth(),
    disk: checkDiskHealth()
  };

  const allHealthy = Object.values(checks).every(check => check);
  
  const status: HealthStatus = {
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: Date.now(),
    checks
  };

  console.log('[Health Check] Result:', status);
  
  return status;
}

/**
 * メイン実行
 */
async function main() {
  try {
    const health = await performHealthCheck();
    
    if (health.status === 'healthy') {
      console.log('[Health Check] ✓ Container is healthy');
      process.exit(0);
    } else {
      console.error('[Health Check] ✗ Container is unhealthy');
      console.error('[Health Check] Failed checks:', 
        Object.entries(health.checks)
          .filter(([, passed]) => !passed)
          .map(([check]) => check)
      );
      process.exit(1);
    }
  } catch (error) {
    console.error('[Health Check] Error during health check:', error);
    process.exit(1);
  }
}

// タイムアウト設定
setTimeout(() => {
  console.error('[Health Check] Health check timed out');
  process.exit(1);
}, HEALTH_CHECK_TIMEOUT + 1000);

main();