# Otedama Solo Mining Guide

## Overview

Otedama Pool now supports both traditional pool mining and solo mining modes, allowing miners to choose their preferred mining method. Our solo mining mode features the **industry's lowest fee at just 0.5%**!

## Features

### Solo Mining Mode
- **Ultra-low 0.5% fee** - The lowest in the industry!
- **Instant payouts** - Get your rewards immediately when you find a block
- **No minimum payout** - Every satoshi counts
- **Full block reward** - Keep 99.5% of the block reward (after 0.5% fee)
- **Seamless mode switching** - Switch between pool and solo mode anytime

### Fee Comparison

| Pool | Solo Fee | Pool Fee |
|------|----------|----------|
| **Otedama** | **0.5%** ✨ | 1% |
| Luxor | 0.7% | 0.7% |
| BTC.com | 1.0% | 1.0% |
| Solo.CKPool | 1-2% | N/A |
| F2Pool | 2.5% | 2.5% |
| AntPool | Variable | Variable |

## How to Connect

### For Solo Mining

1. **Using password field** (Recommended):
   ```
   Server: pool.otedama.com:3333
   Username: YOUR_BTC_ADDRESS.WORKER_NAME
   Password: solo
   ```
   
   Alternative password formats:
   - `x,solo`
   - `mode=solo`
   - `anything,mode=solo`

2. **Using separate port** (if configured):
   ```
   Server: pool.otedama.com:3334
   Username: YOUR_BTC_ADDRESS.WORKER_NAME
   Password: x
   ```

### For Pool Mining

```
Server: pool.otedama.com:3333
Username: YOUR_BTC_ADDRESS.WORKER_NAME
Password: x
```

Or explicitly:
- Password: `pool`
- Password: `x,pool`
- Password: `mode=pool`

## Switching Modes

### Method 1: Reconnect with Different Password
Simply disconnect and reconnect with the appropriate password.

### Method 2: Stratum Command (Advanced)
Send the `mining.set_mode` command:
```json
{"id": 1, "method": "mining.set_mode", "params": ["solo"]}
```

### Method 3: Web Interface
1. Log into the web dashboard
2. Go to Settings → Mining Mode
3. Select your preferred mode
4. Click "Switch Mode"

### Method 4: API
```bash
curl -X POST https://pool.otedama.com/api/v1/mining/mode/switch \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "solo"}'
```

## Configuration Examples

### CGMiner
```bash
cgminer -o stratum+tcp://pool.otedama.com:3333 -u YOUR_BTC_ADDRESS.worker1 -p solo
```

### BFGMiner
```bash
bfgminer -o stratum+tcp://pool.otedama.com:3333 -u YOUR_BTC_ADDRESS.worker1 -p solo
```

### ASIC Configuration
Most ASICs support password-based configuration:
1. Pool URL: `stratum+tcp://pool.otedama.com:3333`
2. Worker: `YOUR_BTC_ADDRESS.ASIC_NAME`
3. Password: `solo` (for solo mining) or `x` (for pool mining)

## Solo Mining Statistics

### Real-time Stats
- Current hashrate
- Shares submitted
- Blocks found
- Estimated time to block
- Total earnings

### API Endpoints
- `/api/v1/solo/status` - Solo mining status
- `/api/v1/solo/stats` - Detailed statistics
- `/api/v1/solo/blocks` - Your solo blocks
- `/api/v1/mining/mode` - Current mining mode

## Rewards and Payouts

### Solo Mining Rewards
- **Block Reward**: Current BTC block reward (3.125 BTC as of 2024)
- **Pool Fee**: 0.5% (0.015625 BTC per block)
- **Your Reward**: 3.109375 BTC per block found
- **Payout**: Instant, directly to your address

### Pool Mining Rewards
- **Payment Scheme**: PPLNS (Pay Per Last N Shares)
- **Pool Fee**: 1%
- **Minimum Payout**: 0.001 BTC
- **Payout Frequency**: Every hour (if above minimum)

## Best Practices

### When to Use Solo Mining
- You have significant hashrate (>1% of pool hashrate)
- You prefer variance for potential higher rewards
- You want the lowest possible fees
- You're mining for the long term

### When to Use Pool Mining
- You have limited hashrate
- You prefer steady, predictable income
- You want to minimize variance
- You're new to mining

## FAQ

**Q: Can I switch modes without losing my stats?**
A: Yes! Your statistics are preserved when switching modes.

**Q: How quickly does mode switching take effect?**
A: Immediately. The next share will be processed in the new mode.

**Q: Are there any penalties for switching modes?**
A: No penalties. Switch as often as you like.

**Q: What happens to my pending pool rewards if I switch to solo?**
A: Pool rewards remain pending and will be paid out normally. Solo mining starts fresh.

**Q: Can I run some workers in pool mode and others in solo?**
A: Yes! Each worker can have its own mode.

## Support

- Discord: https://discord.gg/otedama
- Email: support@otedama.com
- Documentation: https://docs.otedama.com

---

**Start mining with the industry's lowest solo mining fee - just 0.5%!**