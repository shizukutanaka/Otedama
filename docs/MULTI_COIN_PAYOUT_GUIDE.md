# Otedama Multi-Coin Payout Guide

## Overview

Otedama Pool supports flexible payout options, allowing miners to receive rewards in their preferred cryptocurrency. You can choose to receive payouts in the coin you're mining (native) or automatically convert to Bitcoin (BTC) or other supported cryptocurrencies.

## Key Features

### 🌟 Industry-Leading Fee Structure

| Payout Type | Pool Mode | Solo Mode |
|-------------|-----------|-----------|
| Native Coin | 1.0% | 0.5% |
| BTC Conversion | 1.3% | 0.8% |
| Other Coin Conversion | 1.3% | 0.8% |

**Why Our Fees Are Profitable:**
- Bulk exchange rates reduce conversion costs
- Direct integration with major exchanges (Binance, Kraken)
- No hidden withdrawal fees
- Transparent fee breakdown

### 📊 Fee Comparison

| Pool | Native Payout | BTC Conversion | Total Fees |
|------|---------------|----------------|------------|
| **Otedama** | 1.0% / 0.5% | +0.3% | **1.3% / 0.8%** |
| NiceHash | N/A | 2% | 2% + withdrawal |
| Prohashing | 1% | Included | 1% + network fees |

## Supported Cryptocurrencies

- **BTC** - Bitcoin
- **ETH** - Ethereum  
- **LTC** - Litecoin
- **BCH** - Bitcoin Cash
- **DOGE** - Dogecoin
- **RVN** - Ravencoin
- **ERG** - Ergo
- **KAS** - Kaspa
- **ZEC** - Zcash
- **XMR** - Monero

## Setting Up Payout Preferences

### Method 1: During Connection (Stratum)

```
# Native coin payout (default)
Username: YOUR_COIN_ADDRESS.WORKER_NAME
Password: x

# BTC payout
Username: YOUR_COIN_ADDRESS.WORKER_NAME
Password: x,payout=btc,btc_address=YOUR_BTC_ADDRESS

# Custom multi-address setup
Username: YOUR_PRIMARY_ADDRESS.WORKER_NAME
Password: x,btc=1YourBTCAddress,eth=0xYourETHAddress
```

### Method 2: Web Dashboard

1. Log into your account at https://pool.otedama.com
2. Navigate to **Settings** → **Payout Preferences**
3. Select your preferred payout currency
4. Add addresses for each cryptocurrency you want to receive
5. Set minimum payout thresholds
6. Enable/disable auto-conversion

### Method 3: API Configuration

```bash
# Set payout preferences
curl -X POST https://pool.otedama.com/api/v1/payout/preferences \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "currency": "BTC",
    "address": "1YourBTCAddress",
    "autoConvert": true,
    "customAddresses": {
      "ETH": "0xYourETHAddress",
      "LTC": "LYourLTCAddress"
    }
  }'
```

## Payout Options

### 1. Native Coin Payout (Default)
- Receive payouts in the cryptocurrency you're mining
- Lowest fees: 1% (pool) / 0.5% (solo)
- No conversion delays
- Minimum payout: 0.001 (varies by coin)

### 2. BTC Auto-Conversion
- Automatically convert mined coins to Bitcoin
- Total fees: 1.3% (pool) / 0.8% (solo)
- Bulk conversion for better rates
- Minimum payout: 0.0001 BTC

### 3. Multi-Address Payout
- Set different addresses for different coins
- Mine any coin, receive specific cryptocurrencies
- Automatic routing based on your preferences
- Custom minimum thresholds per coin

## How Auto-Conversion Works

1. **Accumulation Phase**
   - Your mined coins accumulate until reaching conversion threshold
   - Default threshold: 0.01 coin value

2. **Bulk Conversion**
   - Coins are converted in bulk every hour (configurable)
   - Bulk orders receive better exchange rates
   - Maximum slippage protection: 1%

3. **Payout Processing**
   - Converted BTC is added to your balance
   - Payouts sent when minimum threshold reached
   - Instant payouts available for balances > 0.01 BTC

## Fee Calculator Examples

### Example 1: Mining ETH, Payout in ETH
- Mined: 0.1 ETH
- Pool fee (1%): 0.001 ETH
- Conversion fee: 0 ETH
- **You receive: 0.099 ETH**

### Example 2: Mining ETH, Payout in BTC
- Mined: 0.1 ETH
- Pool fee (1%): 0.001 ETH
- Conversion fee (0.3%): 0.0003 ETH
- Net ETH: 0.0987 ETH
- At rate 0.065 BTC/ETH: **You receive: 0.0064155 BTC**

### Example 3: Solo Mining LTC, Payout in BTC
- Found block: 12.5 LTC
- Solo fee (0.5%): 0.0625 LTC
- Conversion fee (0.3%): 0.0375 LTC
- Net LTC: 12.4 LTC
- At rate 0.0015 BTC/LTC: **You receive: 0.0186 BTC**

## Minimum Payout Thresholds

| Currency | Default Minimum | Instant Payout |
|----------|----------------|----------------|
| BTC | 0.0001 | 0.01 |
| ETH | 0.005 | 0.1 |
| LTC | 0.01 | 1 |
| BCH | 0.001 | 0.1 |
| DOGE | 10 | 1000 |
| Others | 0.001 equivalent | Varies |

## API Endpoints

### Get Payout Preferences
```
GET /api/v1/payout/preferences
```

### Set Payout Preferences
```
POST /api/v1/payout/preferences
```

### View Exchange Rates
```
GET /api/v1/payout/rates
```

### Calculate Fees
```
POST /api/v1/payout/fees/calculate
{
  "amount": 1.0,
  "fromCoin": "ETH",
  "toCoin": "BTC",
  "mode": "pool"
}
```

## Best Practices

1. **For Maximum Profit**
   - Use native coin payouts when possible (lowest fees)
   - Enable bulk conversion for better exchange rates
   - Set reasonable minimum thresholds to reduce transaction costs

2. **For Convenience**
   - Set up BTC auto-conversion for simplified accounting
   - Use multi-address setup for portfolio diversification
   - Enable instant payouts for quick access to funds

3. **For Security**
   - Use separate addresses for each cryptocurrency
   - Regularly update your payout addresses
   - Monitor your payout history

## FAQ

**Q: Why are your conversion fees so low?**
A: We use bulk exchanges and have partnerships with major exchanges, allowing us to pass savings to miners.

**Q: Can I change my payout preferences anytime?**
A: Yes! Changes take effect immediately for future earnings.

**Q: What happens to pending payouts if I change currencies?**
A: Pending payouts in the old currency are processed normally. New earnings follow new preferences.

**Q: How often are exchange rates updated?**
A: Every 5 minutes from multiple exchange sources.

**Q: Is there a fee for changing payout preferences?**
A: No, changing preferences is always free.

## Support

- Discord: https://discord.gg/otedama
- Email: support@otedama.com
- API Docs: https://docs.otedama.com/api/payouts

---

**Mine any coin, get paid in your preferred cryptocurrency with the lowest fees in the industry!**