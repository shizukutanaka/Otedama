# Rate Limit API Documentation

## Overview

The Rate Limit API allows administrators to dynamically manage rate limiting rules for the Otedama Pool API.

## Authentication

All rate limit management endpoints require admin authentication.

## Endpoints

### Get All Rules

```
GET /api/v1/admin/rate-limits/rules
```

Response:
```json
{
  "total": 4,
  "rules": [
    {
      "id": "api-general",
      "name": "General API Rate Limit",
      "path": "/api/*",
      "method": null,
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 100
      },
      "enabled": true,
      "priority": 1
    }
  ]
}
```

### Get Specific Rule

```
GET /api/v1/admin/rate-limits/rules/:id
```

### Create Rule

```
POST /api/v1/admin/rate-limits/rules
```

Request body:
```json
{
  "id": "custom-limit",
  "name": "Custom API Limit",
  "path": "/api/custom/*",
  "method": "POST",
  "rateLimit": {
    "windowMs": 30000,
    "maxRequests": 50
  },
  "enabled": true,
  "priority": 5
}
```

### Update Rule

```
PUT /api/v1/admin/rate-limits/rules/:id
```

Request body (partial update supported):
```json
{
  "rateLimit": {
    "maxRequests": 200
  },
  "enabled": false
}
```

### Delete Rule

```
DELETE /api/v1/admin/rate-limits/rules/:id
```

Note: Protected rules cannot be deleted.

### Toggle Rule

```
PATCH /api/v1/admin/rate-limits/rules/:id/toggle
```

Toggles the enabled/disabled state of a rule.

### Check Key Status

```
GET /api/v1/admin/rate-limits/status/:key
```

Query parameters:
- `path` - The path to test (default: `/api/test`)
- `method` - The HTTP method (default: `GET`)

### Clear Key

```
DELETE /api/v1/admin/rate-limits/status/:key
```

Clears rate limit data for a specific key.

### Get Statistics

```
GET /api/v1/admin/rate-limits/stats
```

Response:
```json
{
  "totalRequests": 12345,
  "blockedRequests": 123,
  "uniqueKeys": 456,
  "topKeys": [
    {
      "key": "api-general:192.168.1.1:abc123",
      "requests": 1000,
      "blocked": 50
    }
  ],
  "ruleStats": [
    {
      "ruleId": "api-general",
      "applied": 10000,
      "blocked": 100
    }
  ],
  "timestamp": "2024-01-10T12:00:00Z",
  "uptime": 86400
}
```

### Reset Statistics

```
POST /api/v1/admin/rate-limits/stats/reset
```

### Bulk Operations

#### Bulk Create Rules

```
POST /api/v1/admin/rate-limits/rules/bulk
```

Request body:
```json
{
  "rules": [
    {
      "id": "rule1",
      "name": "Rule 1",
      "path": "/api/endpoint1",
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 100
      }
    },
    {
      "id": "rule2",
      "name": "Rule 2",
      "path": "/api/endpoint2",
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 200
      }
    }
  ]
}
```

#### Bulk Update Rules

```
PUT /api/v1/admin/rate-limits/rules/bulk
```

### Presets

#### Get Available Presets

```
GET /api/v1/admin/rate-limits/presets
```

Response:
```json
{
  "strict": {
    "name": "Strict",
    "description": "Strict rate limiting for production",
    "rules": [...]
  },
  "relaxed": {
    "name": "Relaxed",
    "description": "Relaxed rate limiting for development",
    "rules": [...]
  },
  "mining_optimized": {
    "name": "Mining Optimized",
    "description": "Optimized for mining pool operations",
    "rules": [...]
  }
}
```

#### Apply Preset

```
POST /api/v1/admin/rate-limits/presets/:name/apply
```

Request body:
```json
{
  "clearExisting": false
}
```

### Test Rate Limit

```
POST /api/v1/admin/rate-limits/test
```

Request body:
```json
{
  "path": "/api/stats",
  "method": "GET",
  "ip": "192.168.1.1",
  "count": 10
}
```

Response:
```json
{
  "test": {
    "path": "/api/stats",
    "method": "GET",
    "ip": "192.168.1.1",
    "count": 10
  },
  "results": [
    {
      "attempt": 1,
      "allowed": true,
      "remaining": 99,
      "rule": "General API Rate Limit"
    }
  ],
  "summary": {
    "allowed": 10,
    "blocked": 0
  }
}
```

## Rule Configuration

### Rule Properties

- `id` (string, required): Unique identifier for the rule
- `name` (string, required): Human-readable name
- `path` (string, required): Path pattern (supports wildcards: `*` and `?`)
- `method` (string, optional): HTTP method to match
- `rateLimit` (object, required):
  - `windowMs` (number): Time window in milliseconds
  - `maxRequests` (number): Maximum requests per window
- `enabled` (boolean): Whether the rule is active (default: true)
- `priority` (number): Higher priority rules are evaluated first (default: 5)

### Path Patterns

- `/api/*` - Matches any path starting with `/api/`
- `/api/*/stats` - Matches paths like `/api/v1/stats`, `/api/v2/stats`
- `/api/miners/?` - Matches `/api/miners/` followed by any single character

### Protected Rules

The following rules are protected and cannot be deleted:
- `api-general`
- `auth-strict`

## Rate Limit Headers

When rate limiting is applied, the following headers are included in responses:

- `X-RateLimit-Limit`: The maximum number of requests allowed
- `X-RateLimit-Remaining`: The number of requests remaining in the current window
- `X-RateLimit-Reset`: Unix timestamp when the rate limit window resets
- `X-RateLimit-Reset-Time`: ISO 8601 formatted reset time

## Error Responses

When rate limit is exceeded:

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded",
  "retryAfter": 30
}
```

HTTP Status Code: 429

## Best Practices

1. **Start with conservative limits**: Begin with lower limits and increase as needed
2. **Use different rules for different endpoints**: Authentication endpoints should have stricter limits
3. **Monitor statistics regularly**: Check which rules are being triggered most often
4. **Test rules before deployment**: Use the test endpoint to verify behavior
5. **Use presets for common scenarios**: Apply mining_optimized preset for typical pool operations

## Examples

### Create a custom rule for share submissions

```bash
curl -X POST https://api.otedama-pool.com/api/v1/admin/rate-limits/rules \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "share-submission",
    "name": "Share Submission Limit",
    "path": "/api/shares/submit",
    "method": "POST",
    "rateLimit": {
      "windowMs": 10000,
      "maxRequests": 100
    },
    "priority": 8
  }'
```

### Apply mining optimized preset

```bash
curl -X POST https://api.otedama-pool.com/api/v1/admin/rate-limits/presets/mining_optimized/apply \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clearExisting": false
  }'
```

### Test rate limit configuration

```bash
curl -X POST https://api.otedama-pool.com/api/v1/admin/rate-limits/test \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/api/shares/submit",
    "method": "POST",
    "count": 150
  }'
```
