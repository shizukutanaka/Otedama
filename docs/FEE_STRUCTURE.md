# Otedama Pool Fee Structure

## Overview

Our fee structure is designed to be competitive, transparent, and profitable for both miners and the pool. We offer the **lowest solo mining fees in the industry** and competitive pool mining fees with flexible payout options.

## Fee Breakdown

### Base Mining Fees

| Mining Mode | Fee | Industry Average |
|-------------|-----|------------------|
| **Solo Mining** | **0.5%** | 1-2.5% |
| **Pool Mining** | **1.0%** | 1-3% |

### Conversion Fees (Additional)

| Service | Fee | Details |
|---------|-----|---------|
| **BTC Conversion** | **+0.3%** | Covers exchange fees and slippage |
| **Other Coin Conversion** | **+0.3%** | Same rate for all supported coins |
| **Native Payout** | **0%** | No additional fees |

### Total Fee Examples

| Scenario | Total Fee | Competitor Comparison |
|----------|-----------|----------------------|
| Pool Mining → Native Coin | **1.0%** | NiceHash: 2% |
| Pool Mining → BTC | **1.3%** | NiceHash: 2% + withdrawal |
| Solo Mining → Native Coin | **0.5%** | CKPool: 1-2% |
| Solo Mining → BTC | **0.8%** | Lowest in industry |

## How We Ensure Profitability

### 1. Bulk Exchange Operations
- **Strategy**: Accumulate conversions and execute in bulk
- **Benefit**: Better exchange rates (0.1% vs 0.5% for retail)
- **Savings**: 0.4% passed to miners

### 2. Direct Exchange Integration
- **Partners**: Binance (0.1%), Kraken (0.16%)
- **Advantage**: No intermediary fees
- **Result**: Lower costs than competitors using third-party services

### 3. Smart Routing
- **Method**: Automatically select best exchange rates
- **Monitoring**: Real-time rate comparison
- **Protection**: Maximum 1% slippage limit

### 4. Fee Structure Optimization
```
Pool Operation Costs:
- Server Infrastructure: 0.1%
- Network Bandwidth: 0.05%
- Development/Maintenance: 0.15%
- Exchange Fees: 0.1%
- Reserve Fund: 0.1%
Total Operating Cost: ~0.5%

Profit Margins:
- Solo Mining: 0% (promotional)
- Pool Mining: 0.5%
- Conversion Service: 0.2%
```

## Competitive Analysis

### vs NiceHash
- **NiceHash**: 2% + withdrawal fees ($1-5)
- **Otedama**: 1.3% all-inclusive
- **Savings**: 35-65% lower fees

### vs Prohashing
- **Prohashing**: 1% + network fees (~$2/payout)
- **Otedama**: 1.3% all-inclusive
- **Advantage**: No hidden network fees

### vs Solo Mining Pools
- **CKPool**: 1-2% fee
- **Otedama Solo**: 0.5% fee
- **Savings**: 50-75% lower fees

## Profitability Calculations

### Example 1: Mining 1 ETH
```
Market Value: $2,000

Native Payout (Pool):
- Gross: 1 ETH
- Pool Fee (1%): 0.01 ETH
- Net: 0.99 ETH ($1,980)

BTC Payout (Pool):
- Gross: 1 ETH
- Total Fee (1.3%): 0.013 ETH
- Net: 0.987 ETH
- BTC Rate: 0.065
- BTC Received: 0.064155 BTC
- Value: $1,974
```

### Example 2: Solo Block Found (3.125 BTC)
```
Block Reward: 3.125 BTC ($125,000 @ $40k/BTC)

Otedama Solo:
- Fee (0.5%): 0.015625 BTC
- Net: 3.109375 BTC ($124,375)

Competitor Solo (2%):
- Fee: 0.0625 BTC
- Net: 3.0625 BTC ($122,500)

Otedama Advantage: $1,875 more per block
```

## Exchange Integration Details

### Primary: Binance
- Trading Fee: 0.1% (with volume discounts)
- API Integration: Direct market orders
- Liquidity: Highest in industry
- Slippage: < 0.05% for amounts < 10 BTC

### Backup: Kraken
- Trading Fee: 0.16%
- Advantage: Lower withdrawal fees
- Use Case: When Binance rates unfavorable

### Future: DEX Integration
- Planned: Uniswap V3, SushiSwap
- Benefit: Decentralized, no KYC
- Target: Q2 2025

## Fee Transparency

### What's Included
✅ All mining operations
✅ Share validation
✅ Block submission
✅ Payment processing
✅ Exchange fees (for conversions)
✅ Network transaction fees
✅ 24/7 monitoring
✅ DDoS protection

### What's NOT Included
❌ No hidden fees
❌ No withdrawal fees
❌ No minimum balance fees
❌ No inactivity fees

## Minimum Payouts

| Currency | Minimum | Reason |
|----------|---------|--------|
| BTC | 0.0001 | Network fee efficiency |
| ETH | 0.005 | Gas cost optimization |
| Others | Variable | Based on network fees |

## Bulk Discount Program

For large miners (>1% of pool hashrate):
- Additional 0.1% fee reduction
- Priority support
- Custom payout schedules
- Direct exchange rates

## Fee Guarantee

We guarantee:
1. **No fee increases** without 30-day notice
2. **Transparent fee reporting** in all payouts
3. **Best effort** to reduce fees through optimization
4. **Refund policy** for any overcharged fees

## API Fee Calculator

```bash
# Calculate exact fees for your scenario
curl -X POST https://pool.otedama.com/api/v1/payout/fees/calculate \
  -d '{
    "amount": 1.0,
    "fromCoin": "ETH",
    "toCoin": "BTC",
    "mode": "pool"
  }'
```

## Summary

Our fee structure ensures:
- **Profitability**: Sustainable operations with fair margins
- **Competitiveness**: Lowest fees in key categories
- **Transparency**: Clear, upfront pricing
- **Flexibility**: Multiple payout options
- **Efficiency**: Optimized operations reduce costs

---

**Questions?** Contact support@otedama.com or visit our Discord for fee discussions.