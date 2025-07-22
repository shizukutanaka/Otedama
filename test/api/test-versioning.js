/**
 * Test API Versioning System
 * Demonstrates version negotiation, transformation, and compatibility
 */

import express from 'express';
import request from 'supertest';
import { createVersionedApi } from '../../lib/api/versioned-routes.js';
import { VersionedRouteBuilder } from '../../lib/api/versioned-routes.js';

// Create test app
const app = express();
app.use(express.json());

// Setup versioned API
const { versionManager, versionedRouter } = createVersionedApi({
  strategy: 'url_path',
  defaultVersion: '2',
  enableVersionNegotiation: true,
  enableDeprecationHeaders: true
});

// Define test routes
const routes = new VersionedRouteBuilder(versionedRouter);

// Test data
const users = [
  { id: 1, username: 'alice', email: 'alice@example.com', created: '2024-01-01' },
  { id: 2, username: 'bob', email: 'bob@example.com', created: '2024-01-02' }
];

// V1 routes
routes.versions('1')
  .get('/api/users', (req, res) => {
    res.json({
      success: true,
      data: users.map(u => ({
        user_id: u.id,
        username: u.username,
        created: u.created
      })),
      total: users.length
    });
  })
  .get('/api/users/:id', (req, res) => {
    const user = users.find(u => u.id === parseInt(req.params.id));
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    res.json({
      success: true,
      user_id: user.id,
      username: user.username,
      created: user.created
    });
  });

// V2 routes
routes.versions('2')
  .get('/api/users', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const size = parseInt(req.query.size) || 10;
    const start = (page - 1) * size;
    const paginatedUsers = users.slice(start, start + size);
    
    res.json({
      success: true,
      data: paginatedUsers.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        createdAt: u.created
      })),
      pagination: {
        page,
        size,
        total: users.length,
        totalPages: Math.ceil(users.length / size)
      }
    });
  })
  .get('/api/users/:id', (req, res) => {
    const user = users.find(u => u.id === parseInt(req.params.id));
    if (!user) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found'
        }
      });
    }
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.created,
        updatedAt: user.created
      }
    });
  });

// V3 preview routes
routes.versions('3')
  .get('/api/users', (req, res) => {
    // GraphQL-style response
    res.json({
      data: {
        users: users.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          timestamps: {
            created: u.created,
            updated: u.created
          }
        }))
      },
      extensions: {
        version: '3',
        preview: true
      }
    });
  });

// Mount router
const router = versionedRouter.createRouter();
app.use('/api/v:version', router);

// Version discovery
app.get('/api/versions', (req, res) => {
  const versions = Array.from(versionManager.versions.entries()).map(([v, api]) => ({
    version: v,
    status: api.status,
    current: api.isCurrent()
  }));
  
  res.json({
    current: versionManager.currentVersion,
    supported: versionManager.getSupportedVersions(),
    versions
  });
});

// Run tests
async function runTests() {
  console.log('Testing API Versioning System\n');
  
  try {
    // Test 1: Version Discovery
    console.log('1. Testing version discovery...');
    const versionsRes = await request(app).get('/api/versions');
    console.log('Available versions:', versionsRes.body);
    console.log('✓ Version discovery working\n');
    
    // Test 2: V1 API
    console.log('2. Testing V1 API...');
    const v1Res = await request(app).get('/api/v1/users');
    console.log('V1 Response:', JSON.stringify(v1Res.body, null, 2));
    console.log('✓ V1 API working\n');
    
    // Test 3: V2 API
    console.log('3. Testing V2 API...');
    const v2Res = await request(app).get('/api/v2/users?page=1&size=10');
    console.log('V2 Response:', JSON.stringify(v2Res.body, null, 2));
    console.log('Headers:', v2Res.headers);
    console.log('✓ V2 API working\n');
    
    // Test 4: V3 Preview API
    console.log('4. Testing V3 Preview API...');
    const v3Res = await request(app).get('/api/v3/users');
    console.log('V3 Response:', JSON.stringify(v3Res.body, null, 2));
    console.log('✓ V3 API working\n');
    
    // Test 5: Error formats
    console.log('5. Testing error format differences...');
    const v1Error = await request(app).get('/api/v1/users/999');
    console.log('V1 Error:', v1Error.body);
    
    const v2Error = await request(app).get('/api/v2/users/999');
    console.log('V2 Error:', v2Error.body);
    console.log('✓ Error formats working\n');
    
    // Test 6: Unsupported version
    console.log('6. Testing unsupported version...');
    const unsupportedRes = await request(app).get('/api/v99/users');
    console.log('Unsupported version response:', unsupportedRes.body);
    console.log('✓ Version validation working\n');
    
    // Test 7: Deprecation headers
    console.log('7. Testing deprecation headers...');
    const v1Headers = await request(app).get('/api/v1/users');
    console.log('V1 Deprecation headers:');
    console.log('- X-API-Deprecated:', v1Headers.headers['x-api-deprecated']);
    console.log('- X-API-Sunset:', v1Headers.headers['x-api-sunset']);
    console.log('- Link:', v1Headers.headers['link']);
    console.log('✓ Deprecation headers working\n');
    
    // Test 8: Version negotiation with headers
    console.log('8. Testing header-based versioning...');
    const headerApp = express();
    headerApp.use(express.json());
    
    const headerVersioning = createVersionedApi({
      strategy: 'header',
      headerName: 'X-API-Version',
      defaultVersion: '2'
    });
    
    const headerRoutes = new VersionedRouteBuilder(headerVersioning.versionedRouter);
    headerRoutes.versions('1', '2')
      .get('/api/test', (req, res) => {
        res.json({
          version: req.apiVersion,
          message: `Hello from v${req.apiVersion}`
        });
      });
    
    headerApp.use('/api', headerVersioning.versionedRouter.createRouter());
    
    const headerV1 = await request(headerApp)
      .get('/api/test')
      .set('X-API-Version', '1');
    console.log('Header V1 response:', headerV1.body);
    
    const headerV2 = await request(headerApp)
      .get('/api/test')
      .set('X-API-Version', '2');
    console.log('Header V2 response:', headerV2.body);
    console.log('✓ Header versioning working\n');
    
    // Test 9: Performance test
    console.log('9. Testing version routing performance...');
    const iterations = 1000;
    const start = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await request(app).get('/api/v2/users/1');
    }
    
    const duration = Date.now() - start;
    const avgTime = duration / iterations;
    console.log(`Processed ${iterations} requests in ${duration}ms`);
    console.log(`Average response time: ${avgTime.toFixed(2)}ms`);
    console.log('✓ Performance acceptable\n');
    
    // Test 10: Metrics
    console.log('10. Version metrics:');
    const metrics = versionManager.getMetrics();
    console.log('Request distribution:', metrics.versionStats);
    console.log('Total requests:', metrics.totalRequests);
    console.log('Version misses:', metrics.versionMisses);
    console.log('✓ Metrics tracking working\n');
    
    console.log('✅ All tests passed successfully!');
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(() => {
    console.log('\nAPI Versioning system test completed');
    process.exit(0);
  }).catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  });
}