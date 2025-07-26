# Miner Address Setup Guide

## 🔐 Address System Overview

Otedama uses a **dual-address system** for security and transparency:

1. **Pool Operator Address** (Fixed): `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`
   - This address receives pool fees (1%)
   - Cannot be changed or modified
   - Hardcoded for security

2. **Miner Addresses** (Flexible): Your personal wallet address
   - You can use any valid Bitcoin address
   - Supports all address formats
   - Each miner uses their own address

## 📝 Connecting as a Miner

### Basic Connection

```bash
# Connect with your Bitcoin address
cgminer -o stratum+tcp://pool.otedama.local:3333 \
        -u YOUR_BITCOIN_ADDRESS \
        -p x
```

## 💰 How Payouts Work

When you mine on Otedama:

1. **Your Mining Rewards** (99%)
   - Sent directly to YOUR_BITCOIN_ADDRESS
   - Minimum payout: 0.001 BTC
   - Daily payouts at 00:00 UTC

2. **Pool Fee** (1%)
   - Automatically deducted
   - Sent to pool operator: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`
   - Supports pool development and server costs

## 🌍 Multi-Coin Mining

### Bitcoin (BTC)
```bash
-u YOUR_BITCOIN_ADDRESS
```

### Litecoin (LTC)
```bash
-u YOUR_LITECOIN_ADDRESS -o stratum+tcp://pool.otedama.local:3334
```

### Ethereum Classic (ETC)
```bash
-u YOUR_ETHEREUM_ADDRESS -o stratum+tcp://pool.otedama.local:3335
```

### Monero (XMR)
```bash
-u YOUR_MONERO_ADDRESS -o stratum+tcp://pool.otedama.local:3336
```

### Ravencoin (RVN)
```bash
-u YOUR_RAVENCOIN_ADDRESS -o stratum+tcp://pool.otedama.local:3337
```

## ⚠️ Important Notes

### What You CAN Do:
- ✅ Use any valid Bitcoin address format
- ✅ Change your mining address anytime
- ✅ Use different addresses for different workers
- ✅ Mine to exchange addresses
- ✅ Use testnet addresses for testing

### What You CANNOT Do:
- ❌ Use invalid address formats
- ❌ Mine without a valid address

## 🔍 Address Validation

Before connecting, verify your address:

```bash
# Check if your address is valid
curl -X POST http://pool.otedama.local:8081/api/v1/validate-address \
  -H "Content-Type: application/json" \
  -d '{"address": "YOUR_BITCOIN_ADDRESS"}'
```

Response:
```json
{
  "valid": true,
  "type": "SEGWIT",
  "coin": "BTC",
  "format": "segwit"
}
```

## 🛠️ Troubleshooting

### "Invalid wallet address"
- Check address format is correct
- Ensure no extra spaces or characters
- Verify it's not the pool operator address

### "Authorization failed"
- Address might be malformed
- Try with a different address format
- Check network connectivity



### Check Your Stats
```bash
curl http://pool.otedama.local:8081/api/v1/miner/YOUR_BITCOIN_ADDRESS
```

### View Pending Balance
```bash
curl http://pool.otedama.local:8081/api/v1/balance/YOUR_BITCOIN_ADDRESS
```

### Payout History
```bash
curl http://pool.otedama.local:8081/api/v1/payouts/YOUR_BITCOIN_ADDRESS
```



---

Remember: 
- **Your address** = Your mining rewards
- **Pool operator address** = Pool fees (automatic)
- Keep your private keys safe!