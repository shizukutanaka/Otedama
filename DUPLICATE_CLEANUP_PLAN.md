# Duplicate File Cleanup Plan

## Summary
Based on analysis, found multiple duplicate implementations across the codebase. This document outlines the cleanup plan.

## Cleanup Actions

### 1. Rate Limiting
**Keep**: `/lib/security/rate-limiter.js`
**Remove**: `/lib/middleware/enhanced-rate-limiter.js`
**Action**: Merge enhanced features into the main rate limiter

### 2. Memory Management
**Keep**: `/lib/core/memory-manager.js`
**Remove**: 
- `/lib/performance/memory-optimizer.js`
- `/lib/performance/memory-profiler.js`
**Action**: Integrate optimization and profiling into core memory manager

### 3. Dashboard System
**Keep**: `/lib/monitoring/dashboard.js` as main dashboard
**Remove**:
- `/lib/dashboard/realtime-performance-dashboard.js`
**Integrate**: 
- `/lib/api/dashboard-api.js` - Keep as API layer
- `/lib/routes/dashboard-routes.js` - Keep as routing layer
- `/lib/ui/dashboard/` - Keep as UI components

### 4. Connection Pools
**Keep**: `/lib/core/connection-pool.js` as base class
**Specialize**:
- `/lib/network/websocket-connection-pool-optimized.js` - WebSocket specific
- `/lib/database/sqlite-connection-pool.js` - Database specific
**Remove**:
- `/lib/network/websocket-connection-pool.js` (use optimized version)
- `/lib/network/stratum-connection-pool-optimized.js` (merge with stratum server)

### 5. Mining Pool
**Keep**: `/lib/mining/unified-mining-pool.js` as main implementation
**Keep**: `/lib/standalone/standalone-pool.js` for standalone mode
**Remove**: `/lib/pool/advanced-pool-manager.js` (merge features)

### 6. Stratum Server
**Keep**: `/lib/stratum/stratum-v2.js`
**Remove**: Stratum connection pool (integrate into main stratum server)

### 7. Profit Switching
**Keep**: `/lib/profit-switching/` directory structure
**Consolidate**: All profit switching logic into this directory

### 8. Backup System
**Keep**: `/lib/backup/unified-backup-manager.js` as main manager
**Keep**: Other backup utilities as modules

### 9. I18n System
**Keep**: `/lib/i18n/index.js` as main entry
**Remove**: 
- `/lib/i18n/enhanced-i18n-system.js`
- `/lib/i18n/internationalization-system.js`
**Consolidate**: Features into the main i18n module

## Priority Order
1. Remove obvious duplicates
2. Consolidate rate limiting
3. Unify memory management
4. Streamline dashboard system
5. Optimize connection pools
6. Clean up remaining modules

## Expected Benefits
- Reduced codebase size by ~30%
- Improved maintainability
- Better performance (less redundant code)
- Clearer architecture
- Easier testing