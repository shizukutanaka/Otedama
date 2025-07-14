# Otedama v0.5

**Ganap na Awtomatikong P2P Mining Pool + DEX + DeFi Platform**

### 🌍 Language / Wika

<details>
<summary><b>Pumili ng Wika (100 wika ang suportado)</b></summary>

[English](README.md) | [Tagalog](README.tl.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [Español](README.es.md) | [한국어](README.ko.md) | [Tingnan ang lahat ng wika...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## Pangkalahatang-tanaw

Ang Otedama ay isang ganap na awtomatikong komersyal-na-antas na P2P mining pool, DEX, at DeFi platform. Binuo ayon sa mga pilosopiya ng disenyo nina John Carmack (pagganap muna), Robert C. Martin (malinis na arkitektura), at Rob Pike (kasimplehan).

### Mga Pangunahing Tampok

- **Ganap na Awtomatikong Operasyon** - Walang kinakailangang manu-manong interbensyon
- **Hindi Mababagong Sistema ng Bayad** - Hindi mababagong 0.1% BTC awtomatikong koleksyon
- **Suporta sa Maraming Algorithm** - Tugma sa CPU/GPU/ASIC
- **Pinag-isang DEX** - V2 AMM + V3 Concentrated Liquidity
- **Awtomatikong Pagbabayad** - Oras-oras na awtomatikong pagbabayad ng gantimpala sa mga minero
- **Mga Tampok ng DeFi** - Awtomatikong liquidation, pamamahala, tulay
- **Enterprise Grade** - Sumusuporta sa 10,000+ minero

### Mga Tampok ng Operational Automation

1. **Awtomatikong Koleksyon ng Bayad**
   - BTC Address: Hardcoded (hindi mababago)
   - Pool fee: 1.4% (hindi mababago)
   - Operational fee: 0.1% (hindi mababago)
   - Kabuuang bayad: 1.5% (ganap na nakatakda)
   - Dalas ng koleksyon: Bawat 5 minuto
   - Awtomatikong pag-convert ng lahat ng currency sa BTC

2. **Awtomatikong Pamamahagi ng Gantimpala sa Pagmimina**
   - Isinasagawa bawat oras
   - Awtomatikong pagbawas ng pool fees
   - Awtomatikong pagpapadala kapag naabot ang minimum na payout
   - Awtomatikong pagtatala ng transaksyon

3. **Ganap na Awtomatikong DEX/DeFi**
   - Awtomatikong pag-rebalance ng liquidity pools
   - Awtomatikong liquidation (85% LTV)
   - Awtomatikong pagpapatupad ng mga panukala sa pamamahala
   - Awtomatikong pag-relay ng cross-chain bridges

---

## Mga Kinakailangan ng Sistema

### Minimum na Kinakailangan
- Node.js 18+
- RAM: 2GB
- Storage: 10GB SSD
- Network: 100Mbps

### Inirerekomendang Kinakailangan
- CPU: 8+ cores
- RAM: 8GB+
- Storage: 100GB NVMe SSD
- Network: 1Gbps

---

## Pag-install

### 1. Basic na Pag-install

```bash
# I-clone ang repository
git clone https://github.com/otedama/otedama.git
cd otedama

# I-install ang mga dependencies
npm install

# Simulan
npm start
```

### 2. Docker Installation

```bash
# Simulan gamit ang Docker Compose
docker-compose up -d

# Tingnan ang mga log
docker-compose logs -f otedama
```

### 3. One-Click Installation

**Windows:**
```batch
.\quickstart.bat
```

**Linux/macOS:**
```bash
chmod +x quickstart.sh
./quickstart.sh
```

---

## Configuration

### Basic na Configuration

I-edit ang `otedama.json`:

```json
{
  "pool": {
    "name": "Pangalan ng Iyong Pool",
    "fee": 1.0,
    "minPayout": {
      "BTC": 0.001,
      "RVN": 100,
      "XMR": 0.1
    }
  },
  "mining": {
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "Iyong Wallet Address"
  }
}
```

### Command Line Configuration

```bash
# Basic na pagsisimula
node index.js --wallet RYourWalletAddress --currency RVN

# High performance
node index.js --threads 16 --max-miners 5000 --enable-dex

# Custom na mga port
node index.js --api-port 9080 --stratum-port 4444
```

---

## Koneksyon ng Minero

### Impormasyon ng Koneksyon
- Server: `YOUR_IP:3333`
- Username: `WalletAddress.WorkerName`
- Password: `x`

### Mga Halimbawa ng Miner Software

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o YOUR_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Mga Suportadong Currency

| Currency | Algorithm | Min Payout | Bayad |
|----------|-----------|------------|-------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Lahat ng currency: 1.5% flat fee (1.4% pool + 0.1% operational) - hindi mababago

---

## API

### REST Endpoints

```bash
# Pool statistics
GET /api/stats

# Estado ng koleksyon ng bayad
GET /api/fees

# Impormasyon ng minero
GET /api/miners/{minerId}

# Mga presyo ng DEX
GET /api/dex/prices

# Kalusugan ng sistema
GET /health
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['stats', 'mining', 'dex']
}));
```

---

## Impormasyon para sa Operator

### Istruktura ng Kita

1. **Pool Fee**: 1.4% nakatakda (hindi mababago)
2. **Operational Fee**: 0.1% nakatakda (hindi mababago)
3. **Kabuuang Mining Fee**: 1.5% (ganap na nakatakda)
4. **DEX Fee**: 0.3% (ipinamamahagi sa mga liquidity provider)
5. **DeFi Fee**: Bahagi ng interes sa pagpapahiram

### Mga Awtomatikong Gawain

- **Bawat 5 minuto**: Operational fee BTC conversion at koleksyon
- **Bawat 10 minuto**: DEX pool rebalancing
- **Bawat 30 minuto**: DeFi liquidation check
- **Bawat oras**: Awtomatikong pagbabayad sa minero
- **Bawat 24 oras**: Database optimization at backup

### Pagsubaybay

Dashboard: `http://localhost:8080`

Mga Pangunahing Sukatan:
- Aktibong minero
- Hash rate
- Kita mula sa bayad
- DEX volume
- Mga mapagkukunan ng sistema

---

## Seguridad

### Mga Ipinatupad na Proteksyon

1. **DDoS Protection**
   - Multi-layer rate limiting
   - Adaptive thresholds
   - Challenge-response

2. **Sistema ng Pagpapatunay**
   - JWT + MFA
   - Role-based access control
   - API key management

3. **Pag-iwas sa Pambabastos**
   - Hindi mababagong operational fee address
   - Mga pagsusuri sa integridad ng sistema
   - Mga audit log

---

## Troubleshooting

### Ginagamit na Port
```bash
# Tingnan ang prosesong gumagamit ng port
netstat -tulpn | grep :8080

# Itigil ang proseso
kill -9 PID
```

### Mga Isyu sa Memory
```bash
# Taasan ang memory limit ng Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug Mode
```bash
DEBUG=* node index.js
```

---

## Performance Optimization

### Mga Tampok ng Optimization

- **Database Batching**: 70% mas mabilis
- **Network Optimization**: 40% pagbaba ng bandwidth
- **Advanced Caching**: 85%+ hit rate
- **Zero-Copy Operations**: Mahusay na pagproseso ng mining

### Mga Resulta ng Benchmark

```bash
# Patakbuhin ang benchmark
npm run benchmark

# Mga resulta (8 cores, 16GB RAM):
- Database: 50,000+ ops/sec
- Network: 10,000+ msg/sec
- Cache hit rate: 85%+
- Memory usage: <100MB (base)
```

---

## Lisensya

MIT License - Pinapayagan ang komersyal na paggamit

## Suporta

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Ang Kinabukasan ng Awtomatikong Pagmimina

---