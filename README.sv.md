# Otedama v0.5

**Helt Automatiserad P2P Mining Pool + DEX + DeFi Plattform**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Svenska](README.sv.md)

---

## Översikt

Otedama är en helt automatiserad kommersiell P2P mining pool, DEX och DeFi plattform. Byggd enligt designfilosofierna från John Carmack (prestanda först), Robert C. Martin (ren arkitektur) och Rob Pike (enkelhet).

### Huvudfunktioner

- **Helt Automatisk Drift** - Kräver ingen manuell intervention
- **Oföränderligt Avgiftssystem** - Icke-modifierbar automatisk 1,5% BTC-uppbörd
- **Multi-Algoritm Stöd** - CPU/GPU/ASIC kompatibel
- **Enhetlig DEX** - V2 AMM + V3 Koncentrerad Likviditet
- **Automatisk Betalning** - Timvis automatisk utbetalning av belöningar till miners
- **DeFi Funktioner** - Auto-likvidation, styrning, bryggor
- **Enterprise-klass** - Stödjer 10.000+ miners

### Operativa Automatiseringsfunktioner

1. **Automatisk Avgiftsuppbörd**
   - BTC Adress: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (oföränderlig)
   - Pool Avgift: 0% (borttagen)
   - Driftsavgift: 1,5% (icke-modifierbar)
   - Total Avgift: 1,5% (endast driftsavgift)
   - Uppbördsfrekvens: Var 5:e minut
   - Automatisk konvertering av alla valutor till BTC

2. **Automatisk Mining Belöningsdistribution**
   - Körs varje timme
   - Automatiskt avdrag av poolavgifter
   - Automatisk sändning vid uppnådd minimiutbetalning
   - Automatisk transaktionsregistrering

3. **Helt Automatiserad DEX/DeFi**
   - Automatisk ombalansering av likviditetspooler
   - Auto-likvidation (85% LTV)
   - Automatisk exekvering av styrningsförslag
   - Automatisk vidarebefordran av cross-chain bryggor

---

## Systemkrav

### Minimikrav
- Node.js 18+
- RAM: 2GB
- Lagring: 10GB SSD
- Nätverk: 100Mbps

### Rekommenderade Krav
- CPU: 8+ kärnor
- RAM: 8GB+
- Lagring: 100GB NVMe SSD
- Nätverk: 1Gbps

---

## Installation

### 1. Grundinstallation

```bash
# Klona repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Installera beroenden
npm install

# Starta
npm start
```

### 2. Docker Installation

```bash
# Starta med Docker Compose
docker-compose up -d

# Kontrollera loggar
docker-compose logs -f otedama
```

### 3. Ett-Klicks Installation

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

### Grundkonfiguration

Redigera `otedama.json`:

```json
{
  "pool": {
    "name": "Din Pool Namn",
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
    "walletAddress": "Din Plånboksadress"
  }
}
```

### Kommandoradskonfiguration

```bash
# Grundstart
node index.js --wallet RYourWalletAddress --currency RVN

# Hög prestanda
node index.js --threads 16 --max-miners 5000 --enable-dex

# Anpassade portar
node index.js --api-port 9080 --stratum-port 4444
```

---

## Miner Anslutning

### Anslutningsinformation
- Server: `DIN_IP:3333`
- Användarnamn: `PlånboksAdress.WorkerNamn`
- Lösenord: `x`

### Mining Mjukvara Exempel

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

## Stödda Valutor

| Valuta | Algoritm | Min. Utbetalning | Avgift |
|--------|----------|------------------|--------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Alla valutor: 1,5% fast avgift (endast driftsavgift) - icke-modifierbar

---

## API

### REST Slutpunkter

```bash
# Pool statistik
GET /api/stats

# Avgiftsuppbördsstatus
GET /api/fees

# Miner information
GET /api/miners/{minerId}

# DEX priser
GET /api/dex/prices

# Systemhälsa
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

## Operatörsinformation

### Intäktsstruktur

1. **Driftsavgift**: 1,5% fast (icke-modifierbar)
2. **DEX Avgift**: 0,3% (distribueras till likviditetsleverantörer)
3. **DeFi Avgift**: Del av låneräntan

### Automatiserade Uppgifter

- **Var 5:e minut**: Driftsavgift BTC-konvertering och uppbörd
- **Var 10:e minut**: DEX pool ombalansering
- **Var 30:e minut**: DeFi likvidationskontroll
- **Varje timme**: Automatiska miner betalningar
- **Var 24:e timme**: Databasoptimering och säkerhetskopiering

### Övervakning

Instrumentpanel: `http://localhost:8080`

Nyckelmetriker:
- Aktiva miners
- Hashrate
- Avgiftsintäkter
- DEX volym
- Systemresurser

---

## Säkerhet

### Implementerat Skydd

1. **DDoS Skydd**
   - Flernivå hastighetsbegränsning
   - Adaptiva tröskelvärden
   - Utmaning-svar

2. **Autentiseringssystem**
   - JWT + MFA
   - Rollbaserad åtkomstkontroll
   - API-nyckelhantering

3. **Manipulationsförhindrande**
   - Oföränderlig driftsavgiftsadress
   - Systemintegritetskontroller
   - Revisionsloggar

---

## Felsökning

### Port Används
```bash
# Kontrollera process som använder port
netstat -tulpn | grep :8080

# Stoppa process
kill -9 PID
```

### Minnesproblem
```bash
# Öka Node.js minnesgräns
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Felsökningsläge
```bash
DEBUG=* node index.js
```

---

## Prestandaoptimering

### Optimeringsfunktioner

- **Databas Batchning**: 70% snabbare
- **Nätverksoptimering**: 40% bandbreddsreduktion
- **Avancerad Cachning**: 85%+ träfffrekvens
- **Zero-Copy Operationer**: Effektiv miningbearbetning

### Benchmark Resultat

```bash
# Kör benchmark
npm run benchmark

# Resultat (8 kärnor, 16GB RAM):
- Databas: 50.000+ ops/sek
- Nätverk: 10.000+ msg/sek
- Cache träfffrekvens: 85%+
- Minnesanvändning: <100MB (bas)
```

---

## Licens

MIT Licens - Kommersiell användning tillåten

## Support

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Framtiden för Automatiserad Mining

---