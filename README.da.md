# Otedama v0.5

**Fuldt Automatiseret P2P Mining Pool + DEX + DeFi Platform**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Dansk](README.da.md)

---

## Oversigt

Otedama er en fuldt automatiseret kommerciel P2P mining pool, DEX og DeFi platform. Bygget efter designfilosofierne fra John Carmack (ydeevne først), Robert C. Martin (ren arkitektur) og Rob Pike (enkelhed).

### Hovedfunktioner

- **Fuldt Automatisk Drift** - Kræver ingen manuel indgriben
- **Uforanderligt Gebyrssystem** - Ikke-modificerbar automatisk 1,5% BTC-opkrævning
- **Multi-Algoritme Understøttelse** - CPU/GPU/ASIC kompatibel
- **Samlet DEX** - V2 AMM + V3 Koncentreret Likviditet
- **Automatisk Betaling** - Timevis automatisk udbetaling af belønninger til minere
- **DeFi Funktioner** - Auto-likvidation, styring, broer
- **Enterprise-klasse** - Understøtter 10.000+ minere

### Operative Automatiseringsfunktioner

1. **Automatisk Gebyropkrævning**
   - BTC Adresse: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (uforanderlig)
   - Pool Gebyr: 0% (fjernet)
   - Driftsgebyr: 1,5% (ikke-modificerbar)
   - Samlet Gebyr: 1,5% (kun driftsgebyr)
   - Opkrævningsfrekvens: Hver 5. minut
   - Automatisk konvertering af alle valutaer til BTC

2. **Automatisk Mining Belønningsdistribution**
   - Køres hver time
   - Automatisk fradrag af poolgebyrer
   - Automatisk afsendelse ved opnået minimumsudbetaling
   - Automatisk transaktionsregistrering

3. **Fuldt Automatiseret DEX/DeFi**
   - Automatisk rebalancering af likviditetspools
   - Auto-likvidation (85% LTV)
   - Automatisk udførelse af styringsforslag
   - Automatisk videresendelse af cross-chain broer

---

## Systemkrav

### Minimumskrav
- Node.js 18+
- RAM: 2GB
- Lagerplads: 10GB SSD
- Netværk: 100Mbps

### Anbefalede Krav
- CPU: 8+ kerner
- RAM: 8GB+
- Lagerplads: 100GB NVMe SSD
- Netværk: 1Gbps

---

## Installation

### 1. Grundlæggende Installation

```bash
# Klon repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Installer afhængigheder
npm install

# Start
npm start
```

### 2. Docker Installation

```bash
# Start med Docker Compose
docker-compose up -d

# Tjek logs
docker-compose logs -f otedama
```

### 3. Et-Klik Installation

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

## Konfiguration

### Grundlæggende Konfiguration

Rediger `otedama.json`:

```json
{
  "pool": {
    "name": "Dit Pool Navn",
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
    "walletAddress": "Din Tegnebogsadresse"
  }
}
```

### Kommandolinjekonfiguration

```bash
# Grundlæggende opstart
node index.js --wallet RYourWalletAddress --currency RVN

# Høj ydeevne
node index.js --threads 16 --max-miners 5000 --enable-dex

# Tilpassede porte
node index.js --api-port 9080 --stratum-port 4444
```

---

## Miner Forbindelse

### Forbindelsesinformation
- Server: `DIN_IP:3333`
- Brugernavn: `TegnebogsAdresse.WorkerNavn`
- Adgangskode: `x`

### Mining Software Eksempler

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://DIN_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://DIN_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o DIN_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Understøttede Valutaer

| Valuta | Algoritme | Min. Udbetaling | Gebyr |
|--------|-----------|-----------------|-------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Alle valutaer: 1,5% fast gebyr (kun driftsgebyr) - ikke-modificerbar

---

## API

### REST Endepunkter

```bash
# Pool statistik
GET /api/stats

# Gebyropkrævningsstatus
GET /api/fees

# Miner information
GET /api/miners/{minerId}

# DEX priser
GET /api/dex/prices

# Systemsundhed
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

## Operatørinformation

### Indtægtsstruktur

1. **Driftsgebyr**: 1,5% fast (ikke-modificerbar)
2. **DEX Gebyr**: 0,3% (distribueres til likviditetsudbydere)
3. **DeFi Gebyr**: Del af lånerenten

### Automatiserede Opgaver

- **Hver 5. minut**: Driftsgebyr BTC-konvertering og opkrævning
- **Hver 10. minut**: DEX pool rebalancering
- **Hver 30. minut**: DeFi likvidationskontrol
- **Hver time**: Automatiske miner betalinger
- **Hver 24. time**: Databaseoptimering og sikkerhedskopiering

### Overvågning

Dashboard: `http://localhost:8080`

Nøglemetrikker:
- Aktive minere
- Hashrate
- Gebyrindtægter
- DEX volumen
- Systemressourcer

---

## Sikkerhed

### Implementeret Beskyttelse

1. **DDoS Beskyttelse**
   - Flerlags hastighedsbegrænsning
   - Adaptive tærskler
   - Udfordring-respons

2. **Autentifikationssystem**
   - JWT + MFA
   - Rollebaseret adgangskontrol
   - API-nøglehåndtering

3. **Manipulationsforebyggelse**
   - Uforanderlig driftsgebyradresse
   - Systemintegritetskontroller
   - Revisionslogs

---

## Fejlfinding

### Port I Brug
```bash
# Tjek proces der bruger port
netstat -tulpn | grep :8080

# Stop proces
kill -9 PID
```

### Hukommelsesproblemer
```bash
# Øg Node.js hukommelsesgrænse
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Fejlfindings Tilstand
```bash
DEBUG=* node index.js
```

---

## Ydeevneoptimering

### Optimeringsfunktioner

- **Database Batching**: 70% hurtigere
- **Netværksoptimering**: 40% båndbreddereduktion
- **Avanceret Caching**: 85%+ træfrate
- **Zero-Copy Operationer**: Effektiv miningbehandling

### Benchmark Resultater

```bash
# Kør benchmark
npm run benchmark

# Resultater (8 kerner, 16GB RAM):
- Database: 50.000+ ops/sek
- Netværk: 10.000+ msg/sek
- Cache træfrate: 85%+
- Hukommelsesforbrug: <100MB (basis)
```

---

## Licens

MIT Licens - Kommerciel brug tilladt

## Support

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Fremtiden for Automatiseret Mining

---