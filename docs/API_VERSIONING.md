# API Versioning Guide for Otedama

## Overview

Otedama implements a comprehensive API versioning system that supports multiple versioning strategies and ensures backward compatibility as the platform evolves.

## Versioning Strategies

### 1. URL Path Versioning (Default)
```
GET /api/v2/users
GET /api/v3/mining/stats
```

### 2. Header Versioning
```
GET /api/users
X-API-Version: 2
```

### 3. Query Parameter Versioning
```
GET /api/users?version=2
```

### 4. Accept Header Versioning
```
GET /api/users
Accept: application/vnd.api+json;version=2
```

## Current API Versions

| Version | Status | Support End | Description |
|---------|--------|-------------|-------------|
| v1 | Deprecated | 2025-01-01 | Legacy API with basic features |
| v2 | Current | - | Production API with full feature set |
| v3 | Beta | - | Next generation API with GraphQL support |

## Version Lifecycle

1. **Current**: The recommended version for new integrations
2. **Supported**: Stable but not recommended for new projects
3. **Deprecated**: Will be sunset soon, migration recommended
4. **Sunset**: No longer available

## Implementation Guide

### Setting Up Versioned Routes

```javascript
import { VersionedRouteBuilder } from './lib/api/versioned-routes.js';

// Define routes for multiple versions
const routes = new VersionedRouteBuilder(versionedRouter);

// Routes available in v1 and v2
routes.versions('1', '2')
  .get('/api/users', getUsersHandler)
  .post('/api/users', createUserHandler);

// Routes only in v2
routes.versions('2')
  .get('/api/users/:id/sessions', getUserSessionsHandler)
  .post('/api/users/:id/2fa', enable2FAHandler);

// Preview routes in v3
routes.versions('3')
  .post('/api/batch', batchOperationsHandler);
```

### Version-Specific Response Handling

```javascript
routes.versions('1', '2')
  .get('/api/users/:id', (req, res) => {
    const user = await getUser(req.params.id);
    
    if (req.apiVersion === '1') {
      // V1 response format
      res.json({
        user_id: user.id,
        username: user.username,
        created: user.createdAt
      });
    } else {
      // V2 response format
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          createdAt: user.createdAt
        }
      });
    }
  });
```

### Version Transformation

The system automatically transforms requests and responses between versions:

```javascript
// Define transformations
const v1ToV2 = new VersionAdapter('1', '2');

v1ToV2.addResponseTransformer('/api/users/*', 
  CommonTransformers.renameField('created', 'createdAt')
);

v1ToV2.addRequestTransformer('/api/users', 
  CommonTransformers.transformPagination('offset', 'page')
);
```

## API Changes by Version

### V1 → V2 Migration

#### Breaking Changes:
- Session token format changed
- Error response structure standardized
- Field names changed to camelCase
- Pagination changed from offset/limit to page/size

#### New Features:
- Two-factor authentication endpoints
- API key management
- Enhanced error messages
- WebSocket support

#### Migration Example:

**V1 Login Response:**
```json
{
  "success": true,
  "user_id": "123",
  "username": "alice",
  "token": "abc123",
  "expires_at": "2024-01-01T00:00:00Z"
}
```

**V2 Login Response:**
```json
{
  "success": true,
  "user": {
    "id": "123",
    "username": "alice",
    "role": "user"
  },
  "session": {
    "token": "abc123",
    "expiresAt": "2024-01-01T00:00:00Z"
  }
}
```

### V2 → V3 Migration (Future)

#### Planned Changes:
- GraphQL endpoint support
- OAuth2 authentication
- Batch operations
- Webhook management

## Client Implementation

### JavaScript/TypeScript

```typescript
class OtedamaClient {
  constructor(apiVersion = '2') {
    this.apiVersion = apiVersion;
    this.baseURL = '[API_BASE_URL]';
  }
  
  async request(endpoint: string, options = {}) {
    const response = await fetch(
      `${this.baseURL}/api/v${this.apiVersion}${endpoint}`,
      {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      }
    );
    
    // Check for deprecation warnings
    if (response.headers.get('X-API-Deprecated')) {
      console.warn('API version deprecated:', {
        sunset: response.headers.get('X-API-Sunset'),
        link: response.headers.get('Link')
      });
    }
    
    return response.json();
  }
}
```

### Python

```python
import requests
from datetime import datetime

class OtedamaClient:
    def __init__(self, api_version='2'):
        self.api_version = api_version
        self.base_url = '[API_BASE_URL]'
        self.session = requests.Session()
    
    def request(self, method, endpoint, **kwargs):
        url = f"{self.base_url}/api/v{self.api_version}{endpoint}"
        response = self.session.request(method, url, **kwargs)
        
        # Check deprecation
        if response.headers.get('X-API-Deprecated'):
            sunset = response.headers.get('X-API-Sunset')
            print(f"Warning: API v{self.api_version} is deprecated. "
                  f"Sunset date: {sunset}")
        
        response.raise_for_status()
        return response.json()
```

## Version Discovery

### Get Available Versions
```bash
GET /api/versions

Response:
{
  "current": "2",
  "supported": ["1", "2", "3"],
  "versions": [
    {
      "version": "1",
      "status": "deprecated",
      "deprecatedAt": "2024-06-01T00:00:00Z",
      "sunsetAt": "2025-01-01T00:00:00Z"
    },
    {
      "version": "2",
      "status": "current",
      "current": true
    },
    {
      "version": "3",
      "status": "beta"
    }
  ]
}
```

### Get Deprecation Information
```bash
GET /api/deprecation

Response:
{
  "deprecated": [
    {
      "version": "1",
      "deprecatedAt": "2024-06-01T00:00:00Z",
      "sunsetAt": "2025-01-01T00:00:00Z",
      "daysUntilSunset": 42,
      "migrationGuide": "/api/migration/v1-to-v2"
    }
  ]
}
```

## Best Practices

1. **Always specify version explicitly** - Don't rely on default version
2. **Monitor deprecation headers** - Plan migrations early
3. **Test with multiple versions** - Ensure compatibility
4. **Use version negotiation** - Handle version mismatches gracefully
5. **Document version requirements** - Be clear about minimum API version

## Configuration

### Environment Variables

```bash
# API versioning strategy
API_VERSION_STRATEGY=url_path  # url_path, header, query_param, accept_header

# Default version for unspecified requests
API_DEFAULT_VERSION=2

# Version lifecycle settings
API_DEPRECATION_WARNING_DAYS=90
API_SUNSET_GRACE_DAYS=30

# Feature flags
API_ENABLE_VERSION_NEGOTIATION=true
API_ENABLE_DEPRECATION_HEADERS=true
API_ENABLE_VERSION_DISCOVERY=true
```

### Application Setup

```javascript
import { setupVersionedApi } from './lib/api/setup-versioned-api.js';

// Initialize versioned API
const { versionManager, apiRouter } = setupVersionedApi(app, middleware, {
  securityMiddleware,
  authManager,
  miningManager,
  dexManager
});

// Access version metrics
const metrics = versionManager.getMetrics();
console.log('API version usage:', metrics.versionStats);
```

## Troubleshooting

### Common Issues

1. **"Unsupported API version" error**
   - Check the requested version exists
   - Verify version format (no 'v' prefix in header)
   - Use `/api/versions` to see available versions

2. **Missing endpoints in older versions**
   - Some features are only available in newer versions
   - Check endpoint documentation for version availability
   - Consider upgrading to access new features

3. **Response format differences**
   - Use version-specific clients
   - Handle both formats during migration period
   - Test thoroughly with both versions

## Future Roadmap

- **Q1 2025**: V1 API sunset
- **Q2 2025**: V3 API stable release
- **Q3 2025**: GraphQL endpoint GA
- **Q4 2025**: V4 API preview with advanced features

For more information, see the API documentation at `/api/v{version}/docs`.