# API Versioning Guide

## Overview

Otedama Pool API supports multiple versions to ensure backward compatibility while continuously improving functionality.

## Current Versions

- **v1** - Stable, production-ready (default)
- **v2** - Enhanced features with more detailed responses
- **v3-beta** - Experimental GraphQL-compatible endpoints

## Version Selection

### 1. Accept-Version Header (Recommended)

```
GET /api/stats
Accept-Version: v2
```

### 2. URL Path

```
GET /api/v2/stats
```

### 3. Query Parameter

```
GET /api/stats?api_version=v2
```

## Version Information

Get information about available versions:

```
GET /api/versions
```

Response:
```json
{
  "current": "v1",
  "latest": "v2",
  "default": "v1",
  "versions": [
    {
      "version": "v1",
      "deprecated": false
    },
    {
      "version": "v2",
      "deprecated": false,
      "changes": [
        "Enhanced miner stats with additional metrics",
        "New payment calculation algorithm",
        "Improved error responses with error codes",
        "WebSocket support for real-time updates"
      ]
    },
    {
      "version": "v3-beta",
      "deprecated": false,
      "changes": [
        "GraphQL endpoint integration",
        "Batch operations support",
        "Advanced filtering and sorting",
        "Response field selection"
      ]
    }
  ],
  "recommendedVersion": "v2",
  "migrationGuide": "https://docs.otedama-pool.com/api/migration/v1-to-v2"
}
```

## Version-Specific Features

### V1 (Default)
- Basic pool statistics
- Miner information
- Payment history
- Block information

### V2 Features
- **Enhanced Statistics**: More detailed metrics including efficiency and performance data
- **Worker Management**: Individual worker statistics and performance
- **Network Stats**: Real-time network difficulty and predictions
- **Error Codes**: Structured error responses with specific codes
- **Additional Endpoints**:
  - `/api/v2/miners/:address/workers` - Get worker details
  - `/api/v2/miners/:address/performance` - Performance metrics
  - `/api/v2/pool/efficiency` - Pool efficiency metrics
  - `/api/v2/network/stats` - Network statistics

### V3-Beta Features
- **GraphQL Queries**: Send GraphQL-style queries to REST endpoints
- **Batch Operations**: Process multiple requests in a single call
- **Field Selection**: Request only specific fields in responses
- **Example Batch Request**:
  ```json
  POST /api/v3-beta/batch
  {
    "requests": [
      { "type": "poolStats" },
      { "type": "minerStats", "address": "0x..." }
    ]
  }
  ```

## Response Headers

All API responses include version information headers:

- `X-API-Version`: The version used for this request
- `X-Latest-Version`: The latest stable API version
- `X-API-Deprecated`: Present if using a deprecated version
- `Warning`: Deprecation warnings when applicable

## Migration Guide

### V1 to V2

Key changes when migrating from v1 to v2:

1. **Miner Stats Structure**
   - V1: `{ hashrate, shares, balance }`
   - V2: `{ currentHashrate, hashrate24h, validShares, invalidShares, unpaidBalance, efficiency }`

2. **Error Responses**
   - V1: `{ error: "Message" }`
   - V2: `{ error: "Message", code: "ERROR_CODE", details: {...} }`

3. **New Required Fields**
   - Some endpoints now require additional parameters
   - Check the API documentation for specifics

### Backward Compatibility

- V1 endpoints remain fully functional
- Responses are automatically transformed when older versions are requested
- No breaking changes within major versions

## Best Practices

1. **Always specify version**: Use Accept-Version header for clarity
2. **Monitor deprecation warnings**: Check response headers
3. **Test with new versions**: Use staging environment first
4. **Update gradually**: Migrate endpoint by endpoint
5. **Handle version-specific features**: Check capabilities before using

## Example Code

### JavaScript/TypeScript
```typescript
// Using fetch with version header
const response = await fetch('https://api.otedama-pool.com/api/stats', {
  headers: {
    'Accept-Version': 'v2',
    'Authorization': 'Bearer YOUR_TOKEN'
  }
});

// Check version in response
const apiVersion = response.headers.get('X-API-Version');
console.log(`Using API version: ${apiVersion}`);
```

### curl
```bash
# Request v2 stats
curl -H "Accept-Version: v2" https://api.otedama-pool.com/api/stats

# Use URL versioning
curl https://api.otedama-pool.com/api/v2/stats
```

## Support

For questions about API versioning:
- Documentation: https://docs.otedama-pool.com/api
- Support: support@otedama-pool.com
- Discord: #api-support channel
