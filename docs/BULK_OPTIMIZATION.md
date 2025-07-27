# Bulk Conversion Optimization

## Overview

The Otedama mining pool implements an advanced bulk conversion optimization system that aggregates small cryptocurrency conversions into larger batches, achieving better exchange rates and lower fees through volume discounts.

## Key Benefits

### 1. Reduced Conversion Fees
- **Individual conversions**: 0.2% fee per transaction
- **Bulk conversions**: 0.15% fee for aggregated transactions
- **Volume discounts**: Additional 0.05-0.2% discount based on volume
- **Total savings**: Up to 0.25% saved on conversion fees

### 2. Better Exchange Rates
- Larger orders receive preferential rates from exchanges
- Reduced slippage on bigger volumes
- Access to institutional-grade pricing tiers

### 3. Optimized Network Fees
- Single large transaction instead of multiple small ones
- Reduced blockchain fees through batching
- Lower gas costs for smart contract interactions

## How It Works

### Automatic Batching

1. **Small Conversion Detection**
   - Conversions below the minimum batch size are queued
   - Default thresholds:
     - BTC: 0.01 BTC
     - ETH: 0.1 ETH
     - LTC: 1 LTC
     - Other: $50 USD equivalent

2. **Intelligent Aggregation**
   - Similar conversions (same coin pair) are grouped
   - Queue monitored for optimal batch size
   - Maximum wait time: 1 hour

3. **Batch Processing**
   - Triggered when:
     - Minimum batch size reached
     - Maximum wait time exceeded
     - Priority threshold met (90% of minimum)
     - Maximum batch size reached (100 conversions)

### Volume Discount Tiers

| Volume (USD) | Discount Rate | Effective Fee Reduction |
|--------------|---------------|------------------------|
| $1,000+      | 0.05%         | 0.2% → 0.15%          |
| $5,000+      | 0.10%         | 0.2% → 0.10%          |
| $10,000+     | 0.15%         | 0.2% → 0.05%          |
| $50,000+     | 0.20%         | 0.2% → 0.00%          |

## Configuration

### Enable Bulk Optimization

```javascript
// config/default.json
{
  "payouts": {
    "bulkOptimizationEnabled": true,
    "bulkConversionSettings": {
      "minBatchSize": {
        "BTC": 0.01,
        "ETH": 0.1,
        "LTC": 1,
        "default": 50
      },
      "maxWaitTime": 3600000,
      "checkInterval": 60000
    }
  }
}
```

### Miner Settings

Miners can control batching behavior:

```javascript
// Allow batching (default)
await pool.setPayoutPreferences(minerId, {
  currency: 'BTC',
  allowBatching: true
});

// Force immediate conversion
await pool.setPayoutPreferences(minerId, {
  currency: 'BTC',
  allowBatching: false,
  priority: true
});
```

## Supported Services

Bulk conversions are supported by:

1. **SimpleSwap**
   - Native bulk API support
   - Multiple output addresses
   - 0% trading fees + 0.5% spread

2. **ChangeNOW**
   - Bulk exchange API
   - Volume discounts available
   - 0.5% fixed fee

3. **CoinPayments**
   - Mass withdrawal API
   - 1300+ supported coins
   - 0.5% fee structure

## Monitoring

### Real-time Statistics

```bash
# View bulk optimization stats
curl http://localhost:8080/api/v1/stats/bulk-optimization

# Response
{
  "totalBatches": 156,
  "totalConversions": 892,
  "totalVolume": 45.67,
  "totalSaved": 0.114,
  "averageBatchSize": 5.7,
  "averageSavings": "0.25%",
  "queuedConversions": 12,
  "activeBatches": 2
}
```

### Batch Status

```bash
# Check current batch queues
curl http://localhost:8080/api/v1/admin/services/bulk/status

# Response
{
  "ETH:BTC": {
    "conversions": 8,
    "totalAmount": 0.87,
    "progress": "87%",
    "estimatedProcessingTime": "2024-12-11T15:30:00Z"
  }
}
```

## Example Savings

### Scenario 1: Small Miners
- 10 miners converting 0.02 ETH each to BTC
- Individual fees: 10 × (0.02 × 0.2%) = 0.0004 ETH
- Bulk fee: 0.2 × 0.15% = 0.0003 ETH
- Savings: 25% reduction in fees

### Scenario 2: Medium Pool
- 50 conversions totaling 5 ETH ($15,000)
- Individual fees: 5 × 0.2% = 0.01 ETH
- Bulk fee: 5 × 0.1% = 0.005 ETH (with volume discount)
- Savings: 50% reduction in fees

### Scenario 3: Large Operations
- 200 conversions totaling 20 ETH ($60,000)
- Individual fees: 20 × 0.2% = 0.04 ETH
- Bulk fee: 20 × 0% = 0 ETH (maximum volume discount)
- Savings: 100% fee elimination

## Best Practices

1. **Enable for Small Payouts**
   - Most beneficial for amounts under $500
   - Larger amounts can opt for immediate processing

2. **Monitor Queue Times**
   - Average wait time: 15-30 minutes
   - Maximum wait: 1 hour
   - Priority users processed faster

3. **Review Service Status**
   - Check service health before large batches
   - Monitor rate anomalies
   - Have fallback options ready

4. **Optimize Batch Sizes**
   - Adjust thresholds based on miner patterns
   - Consider peak/off-peak timing
   - Balance savings vs. processing time

## API Reference

### Add Conversion to Bulk Queue

```javascript
const result = await converter.convert({
  fromCoin: 'ETH',
  toCoin: 'BTC',
  amount: 0.05,
  address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  userId: 'miner123',
  allowBatching: true
});

// Response
{
  "id": "batch_abc123",
  "status": "queued",
  "estimatedProcessingTime": 1702314000000
}
```

### Force Immediate Conversion

```javascript
const result = await converter.convert({
  fromCoin: 'ETH',
  toCoin: 'BTC',
  amount: 1.5,
  address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  userId: 'whale456',
  allowBatching: false,
  priority: true
});

// Response
{
  "id": "tx_def456",
  "status": "completed",
  "transactionId": "0x123..."
}
```

## Troubleshooting

### Conversion Stuck in Queue
1. Check batch status endpoint
2. Verify minimum thresholds
3. Check service health
4. Force process if needed

### Lower Than Expected Savings
1. Verify volume discount tiers
2. Check actual batch sizes
3. Monitor service fees
4. Review timing patterns

### Service Failures
1. Automatic fallback to individual processing
2. Check failover logs
3. Monitor service status
4. Adjust service priorities

## Security Considerations

1. **Privacy Protection**
   - User addresses never shared between batches
   - Individual amounts tracked separately
   - No cross-contamination of funds

2. **Fair Distribution**
   - Proportional allocation of converted amounts
   - Transparent fee distribution
   - Audit trail for all conversions

3. **Risk Management**
   - Maximum batch size limits
   - Timeout protections
   - Automatic fallback mechanisms
   - Rate anomaly detection