# Otedama v0.5

**Cikakken Tsarin P2P Mining Pool + DEX + DeFi mai sarrafa kansa**

### 🌍 Language / Harshe

<details>
<summary><b>Zaɓi Harshe (Ana tallafawa harsuna 100)</b></summary>

[English](README.md) | [Hausa](README.ha.md) | [العربية](README.ar.md) | [Kiswahili](README.sw.md) | [Yorùbá](README.yo.md) | [日本語](README.ja.md) | [Duba dukkan harsunan...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## Bayyani

Otedama shine cikakken tsarin P2P mining pool, DEX da DeFi mai sarrafa kansa na kasuwanci. An gina shi bisa falsafar ƙira ta John Carmack (aiki na farko), Robert C. Martin (tsari mai tsabta) da Rob Pike (sauƙi).

### Abubuwan Mahimmanci

- **Aiki Mai Cikakken Sarrafa Kansa** - Ba a buƙatar sa hannu ba
- **Tsarin Kuɗi da Ba Ya Canjawa** - Karɓar 0.1% BTC mai sarrafa kansa wanda ba za'a iya canza shi ba
- **Goyan baya ga Algorithm da yawa** - Mai dacewa da CPU/GPU/ASIC
- **DEX Mai Haɗuwa** - V2 AMM + V3 Concentrated Liquidity
- **Biyan Kuɗi na Atomatik** - Biyan ladan masu mining duk sa'a
- **Ayyukan DeFi** - Rushewa ta atomatik, mulki, gada
- **Matakin Kasuwanci** - Yana tallafawa masu mining 10,000+

### Ayyukan Sarrafa Aiki

1. **Karɓar Kuɗi ta Atomatik**
   - Adireshin BTC: An rubuta shi sosai (ba za'a iya canza shi ba)
   - Kuɗin pool: 1.4% (ba za'a iya canza shi ba)
   - Kuɗin aiki: 0.1% (ba za'a iya canza shi ba)
   - Jimlar kuɗi: 1.5% (daidai sosai)
   - Lokacin karɓa: Kowane minti 5
   - Canza duk kuɗaɗe zuwa BTC ta atomatik

2. **Rarraba Ladan Mining ta Atomatik**
   - Ana yin shi kowane awa
   - Cire kuɗin pool ta atomatik
   - Aikawa ta atomatik lokacin da aka kai mafi ƙarancin biya
   - Rikodin ma'amala ta atomatik

3. **DEX/DeFi Mai Cikakken Sarrafa Kansa**
   - Daidaita wuraren ruwa ta atomatik
   - Rushewa ta atomatik (85% LTV)
   - Aiwatar da shawarwarin mulki ta atomatik
   - Isar da gadoji tsakanin sarƙoƙi ta atomatik

---

## Bukatun Tsarin

### Mafi Ƙarancin Buƙatu
- Node.js 18+
- RAM: 2GB
- Ajiya: 10GB SSD
- Hanyar sadarwa: 100Mbps

### Buƙatun da Aka Ba da Shawara
- CPU: 8+ cores
- RAM: 8GB+
- Ajiya: 100GB NVMe SSD
- Hanyar sadarwa: 1Gbps

---

## Shigarwa

### 1. Shigarwa ta Asali

```bash
# Kwafi wurin ajiya
git clone https://github.com/otedama/otedama.git
cd otedama

# Shigar da abubuwan dogaro
npm install

# Fara
npm start
```

### 2. Shigarwar Docker

```bash
# Fara da Docker Compose
docker-compose up -d

# Duba rajista
docker-compose logs -f otedama
```

### 3. Shigarwa ta Dannawa Ɗaya

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

## Daidaitawa

### Daidaitawa na Asali

Gyara `otedama.json`:

```json
{
  "pool": {
    "name": "Sunan Pool ɗinku",
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
    "walletAddress": "Adireshin Wallet ɗinku"
  }
}
```

### Daidaitawar Layin Umarni

```bash
# Farawa na asali
node index.js --wallet RYourWalletAddress --currency RVN

# Babban aiki
node index.js --threads 16 --max-miners 5000 --enable-dex

# Tashoshin al'ada
node index.js --api-port 9080 --stratum-port 4444
```

---

## Haɗin Mai Mining

### Bayanan Haɗi
- Sabar: `YOUR_IP:3333`
- Sunan mai amfani: `WalletAddress.WorkerName`
- Kalmar sirri: `x`

### Misalan Software na Mining

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

## Kuɗaɗen da Ake Tallafawa

| Kuɗi | Algorithm | Mafi ƙarancin Biya | Kuɗi |
|------|-----------|-------------------|------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Duk kuɗaɗe: kuɗi mai tsayi na 1.5% (pool 1.4% + aiki 0.1%) - ba za'a iya canza shi ba

---

## API

### Wuraren REST

```bash
# Ƙididdigan pool
GET /api/stats

# Matsayin karɓar kuɗi
GET /api/fees

# Bayanan mai mining
GET /api/miners/{minerId}

# Farashin DEX
GET /api/dex/prices

# Lafiyar tsarin
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

## Bayanan Mai Gudanarwa

### Tsarin Samun Kuɗi

1. **Kuɗin Pool**: 1.4% mai tsayi (ba za'a iya canza shi ba)
2. **Kuɗin Aiki**: 0.1% mai tsayi (ba za'a iya canza shi ba)
3. **Jimlar Kuɗin Mining**: 1.5% (daidai sosai)
4. **Kuɗin DEX**: 0.3% (ana rarraba ga masu bayar da ruwa)
5. **Kuɗin DeFi**: Sashen riba daga rance

### Ayyukan Atomatik

- **Kowane minti 5**: Canza kuɗin aiki zuwa BTC da karɓa
- **Kowane minti 10**: Daidaita wuraren ruwan DEX
- **Kowane minti 30**: Duban rushewar DeFi
- **Kowane awa**: Biyan masu mining ta atomatik
- **Kowane awa 24**: Inganta database da ajiyar baya

### Sa ido

Dashboard: `http://localhost:8080`

Muhimman Ma'auni:
- Masu mining masu aiki
- Ƙimar hash
- Samun kuɗin kuɗi
- Girman DEX
- Albarkatun tsarin

---

## Tsaro

### Kariyar da Aka Aiwatar

1. **Kariyar DDoS**
   - Iyakancewar ƙima mai yawa
   - Kofa mai daidaitawa
   - Ƙalubale-amsa

2. **Tsarin Tabbatarwa**
   - JWT + MFA
   - Sarrafa shiga bisa matsayi
   - Gudanar da maɓallin API

3. **Hana Ɓarna**
   - Adireshin kuɗin aiki da ba za'a iya canza shi ba
   - Duban daidaiton tsarin
   - Rajistan bincike

---

## Warware Matsaloli

### Tashar tana Aiki
```bash
# Duba tsarin da ke amfani da tashar
netstat -tulpn | grep :8080

# Dakatar da tsari
kill -9 PID
```

### Matsalolin Ƙwaƙwalwa
```bash
# Ƙara iyakar ƙwaƙwalwar Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Yanayin Gyara Kuskure
```bash
DEBUG=* node index.js
```

---

## Inganta Aiki

### Ayyukan Ingantawa

- **Tarawa ta Database**: 70% mafi sauri
- **Inganta Hanyar sadarwa**: Rage bandwidth da 40%
- **Cache mai ci gaba**: 85%+ ƙimar ci
- **Ayyukan Zero-Copy**: Sarrafa mining mai inganci

### Sakamakon Gwaji

```bash
# Gudanar da gwaji
npm run benchmark

# Sakamako (cores 8, 16GB RAM):
- Database: 50,000+ ops/daƙiƙa
- Hanyar sadarwa: 10,000+ msg/daƙiƙa
- Ƙimar cin cache: 85%+
- Amfani da ƙwaƙwalwa: <100MB (tushe)
```

---

## Lasisi

Lasisi MIT - Ana ba da izinin amfani na kasuwanci

## Taimako

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Makomar Mining Mai sarrafa kansa

---