# Otedama v0.5

**ሙሉ በሙሉ አውቶማቲክ P2P ማዕድን ገንዳ + DEX + DeFi መድረክ**

### 🌍 Language / ቋንቋ

<details>
<summary><b>ቋንቋ ይምረጡ (100 ቋንቋዎች ይደገፋሉ)</b></summary>

[English](README.md) | [አማርኛ](README.am.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [العربية](README.ar.md) | [Español](README.es.md) | [ሁሉንም ቋንቋዎች ይመልከቱ...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## ጠቅላላ እይታ

Otedama ሙሉ በሙሉ አውቶማቲክ የንግድ ደረጃ P2P ማዕድን ገንዳ፣ DEX እና DeFi መድረክ ነው። የተገነባው በጆን ካርማክ (አፈፃፀም መጀመሪያ)፣ ሮበርት ሲ. ማርቲን (ንፁህ አርክቴክቸር) እና ሮብ ፓይክ (ቀላልነት) የንድፍ ፍልስፍናዎች መሰረት ነው።

### ዋና ባህሪያት

- **ሙሉ በሙሉ አውቶማቲክ ክወና** - ዜሮ የእጅ ጣልቃገብነት አያስፈልግም
- **የማይለወጥ ክፍያ ስርዓት** - የማይለወጥ 0.1% BTC አውቶማቲክ ስብስብ
- **ብዙ-አልጎሪዝም ድጋፍ** - ከCPU/GPU/ASIC ጋር ተስማሚ
- **የተዋሃደ DEX** - V2 AMM + V3 የተጠናከረ ፈሳሽነት
- **አውቶማቲክ ክፍያ** - ሰዓታዊ አውቶማቲክ የማዕድን ሰራተኛ ሽልማት ክፍያዎች
- **DeFi ባህሪያት** - አውቶ-ሊኩዊዴሽን፣ አስተዳደር፣ ድልድይ
- **የድርጅት ደረጃ** - 10,000+ ማዕድን ሰራተኞችን ይደግፋል

### የክወና አውቶሜሽን ባህሪያት

1. **አውቶማቲክ ክፍያ ስብስብ**
   - BTC አድራሻ: በጠንካራ ኮድ የተደረገ (የማይለወጥ)
   - የገንዳ ክፍያ: 1.4% (የማይለወጥ)
   - የክወና ክፍያ: 0.1% (የማይለወጥ)
   - ጠቅላላ ክፍያ: 1.5% (ሙሉ በሙሉ ቋሚ)
   - የስብስብ ድግግሞሽ: በየ5 ደቂቃ
   - ሁሉንም ምንዛሬዎች ወደ BTC አውቶማቲክ ቅየራ

2. **አውቶማቲክ የማዕድን ሽልማት ስርጭት**
   - በየሰዓቱ ይከናወናል
   - አውቶማቲክ የገንዳ ክፍያ ተቀናሽ
   - ዝቅተኛ ክፍያ ሲደርስ አውቶማቲክ መላክ
   - አውቶማቲክ ግብይት መዝገብ

3. **ሙሉ በሙሉ አውቶማቲክ DEX/DeFi**
   - የፈሳሽነት ገንዳዎች አውቶማቲክ ዳግም ማመጣጠን
   - አውቶ-ሊኩዊዴሽን (85% LTV)
   - የአስተዳደር ሃሳቦች አውቶማቲክ አፈፃፀም
   - የመስቀል-ሰንሰለት ድልድዮች አውቶማቲክ ማስተላለፍ

---

## የስርዓት መስፈርቶች

### ዝቅተኛ መስፈርቶች
- Node.js 18+
- RAM: 2GB
- ማከማቻ: 10GB SSD
- አውታረ መረብ: 100Mbps

### የሚመከሩ መስፈርቶች
- CPU: 8+ ኮሮች
- RAM: 8GB+
- ማከማቻ: 100GB NVMe SSD
- አውታረ መረብ: 1Gbps

---

## መጫን

### 1. መሰረታዊ መጫን

```bash
# ማከማቻውን ይቅዱ
git clone https://github.com/otedama/otedama.git
cd otedama

# ጥገኞችን ይጫኑ
npm install

# ይጀምሩ
npm start
```

### 2. Docker መጫን

```bash
# በDocker Compose ይጀምሩ
docker-compose up -d

# ምዝግቦችን ይመልከቱ
docker-compose logs -f otedama
```

### 3. አንድ-ጠቅታ መጫን

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

## ውቅር

### መሰረታዊ ውቅር

`otedama.json`ን ያርትዑ:

```json
{
  "pool": {
    "name": "የእርስዎ ገንዳ ስም",
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
    "walletAddress": "የእርስዎ ዋሌት አድራሻ"
  }
}
```

### የትዕዛዝ መስመር ውቅር

```bash
# መሰረታዊ ጅምር
node index.js --wallet RYourWalletAddress --currency RVN

# ከፍተኛ አፈፃፀም
node index.js --threads 16 --max-miners 5000 --enable-dex

# ብጁ ወደቦች
node index.js --api-port 9080 --stratum-port 4444
```

---

## የማዕድን ሰራተኛ ግንኙነት

### የግንኙነት መረጃ
- አገልጋይ: `YOUR_IP:3333`
- የተጠቃሚ ስም: `WalletAddress.WorkerName`
- የይለፍ ቃል: `x`

### የማዕድን ሶፍትዌር ምሳሌዎች

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

## የሚደገፉ ምንዛሬዎች

| ምንዛሬ | አልጎሪዝም | ዝቅተኛ ክፍያ | ክፍያ |
|-------|----------|-------------|-------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

ሁሉም ምንዛሬዎች: 1.5% ጠፍጣፋ ክፍያ (1.4% ገንዳ + 0.1% ክወና) - የማይለወጥ

---

## API

### REST ማብቂያ ነጥቦች

```bash
# የገንዳ ስታቲስቲክስ
GET /api/stats

# ክፍያ ስብስብ ሁኔታ
GET /api/fees

# የማዕድን ሰራተኛ መረጃ
GET /api/miners/{minerId}

# DEX ዋጋዎች
GET /api/dex/prices

# የስርዓት ጤና
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

## የኦፕሬተር መረጃ

### የገቢ መዋቅር

1. **የገንዳ ክፍያ**: 1.4% ቋሚ (የማይለወጥ)
2. **የክወና ክፍያ**: 0.1% ቋሚ (የማይለወጥ)
3. **ጠቅላላ የማዕድን ክፍያ**: 1.5% (ሙሉ በሙሉ ቋሚ)
4. **DEX ክፍያ**: 0.3% (ለፈሳሽነት አቅራቢዎች የሚሰራጭ)
5. **DeFi ክፍያ**: የብድር ወለድ ክፍል

### አውቶማቲክ ተግባራት

- **በየ5 ደቂቃ**: የክወና ክፍያ BTC ቅየራ እና ስብስብ
- **በየ10 ደቂቃ**: DEX ገንዳዎች ዳግም ማመጣጠን
- **በየ30 ደቂቃ**: DeFi ሊኩዊዴሽን ቼክ
- **በየሰዓቱ**: አውቶማቲክ የማዕድን ሰራተኛ ክፍያዎች
- **በየ24 ሰዓቱ**: የውሂብ ቤዝ ማመቻቸት እና መጠባበቂያ

### ክትትል

ዳሽቦርድ: `http://localhost:8080`

ቁልፍ መለኪያዎች:
- ንቁ የማዕድን ሰራተኞች
- የሃሽ መጠን
- የክፍያ ገቢ
- DEX መጠን
- የስርዓት ሀብቶች

---

## ደህንነት

### የተተገበሩ ጥበቃዎች

1. **DDoS ጥበቃ**
   - ብዙ-ንብርብር ፍጥነት ገደብ
   - መላመድ የሚችሉ ገደቦች
   - ፈተና-ምላሽ

2. **የማረጋገጫ ስርዓት**
   - JWT + MFA
   - ሚና-ተኮር የመዳረሻ ቁጥጥር
   - API ቁልፍ አስተዳደር

3. **የማበላሸት መከላከል**
   - የማይለወጥ የክወና ክፍያ አድራሻ
   - የስርዓት ትክክለኛነት ፍተሻዎች
   - የኦዲት ምዝግቦች

---

## ችግር መፍታት

### ወደብ በመጠቀም ላይ
```bash
# ወደቡን የሚጠቀመውን ሂደት ይፈትሹ
netstat -tulpn | grep :8080

# ሂደቱን ያቁሙ
kill -9 PID
```

### የማህደረ ትውስታ ጉዳዮች
```bash
# የNode.js ማህደረ ትውስታ ገደብ ይጨምሩ
export NODE_OPTIONS="--max-old-space-size=8192"
```

### የስህተት ማረም ሁነታ
```bash
DEBUG=* node index.js
```

---

## የአፈፃፀም ማመቻቸት

### የማመቻቸት ባህሪያት

- **የውሂብ ቤዝ ባች ማድረግ**: 70% ፈጣን
- **የአውታረ መረብ ማመቻቸት**: 40% የመተላለፊያ ይዘት ቅነሳ
- **የላቀ መሸጎጫ**: 85%+ የምት መጠን
- **ዜሮ-ቅጂ ክወናዎች**: ቀልጣፋ የማዕድን ሂደት

### የመለኪያ ውጤቶች

```bash
# መለኪያ ያካሂዱ
npm run benchmark

# ውጤቶች (8 ኮሮች፣ 16GB RAM):
- የውሂብ ቤዝ: 50,000+ ops/ሰከንድ
- አውታረ መረብ: 10,000+ msg/ሰከንድ
- የመሸጎጫ ምት መጠን: 85%+
- የማህደረ ትውስታ አጠቃቀም: <100MB (መሰረት)
```

---

## ፍቃድ

MIT ፍቃድ - የንግድ አጠቃቀም ተፈቅዷል

## ድጋፍ

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - የአውቶማቲክ ማዕድን ወደፊት

---