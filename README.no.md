# Otedama v0.5

**Helautomatisk P2P Mining Pool + DEX + DeFi Plattform**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Norsk](README.no.md)

---

## Oversikt

Otedama er en helautomatisk kommersiell P2P mining pool, DEX og DeFi plattform. Bygget etter designfilosofiene til John Carmack (ytelse først), Robert C. Martin (ren arkitektur) og Rob Pike (enkelhet).

### Hovedfunksjoner

- **Helautomatisk Drift** - Krever ingen manuell inngripen
- **Uforanderlig Avgiftssystem** - Ikke-modifiserbar automatisk 1,5% BTC-innkreving
- **Multi-Algoritme Støtte** - CPU/GPU/ASIC kompatibel
- **Enhetlig DEX** - V2 AMM + V3 Konsentrert Likviditet
- **Automatisk Betaling** - Timevis automatisk utbetaling av belønninger til minere
- **DeFi Funksjoner** - Auto-likvidering, styring, broer
- **Enterprise-klasse** - Støtter 10.000+ minere

### Operative Automatiseringsfunksjoner

1. **Automatisk Avgiftsinnkreving**
   - BTC Adresse: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (uforanderlig)
   - Pool Avgift: 0% (fjernet)
   - Driftsavgift: 1,5% (ikke-modifiserbar)
   - Total Avgift: 1,5% (kun driftsavgift)
   - Innkrevingsfrekvens: Hvert 5. minutt
   - Automatisk konvertering av alle valutaer til BTC

2. **Automatisk Mining Belønningsdistribusjon**
   - Kjøres hver time
   - Automatisk fradrag av poolavgifter
   - Automatisk sending ved oppnådd minimumsutbetaling
   - Automatisk transaksjonsregistrering

3. **Helautomatisk DEX/DeFi**
   - Automatisk rebalansering av likviditetspooler
   - Auto-likvidering (85% LTV)
   - Automatisk utførelse av styringsforslag
   - Automatisk videresending av cross-chain broer

---

## Systemkrav

### Minimumskrav
- Node.js 18+
- RAM: 2GB
- Lagring: 10GB SSD
- Nettverk: 100Mbps

### Anbefalte Krav
- CPU: 8+ kjerner
- RAM: 8GB+
- Lagring: 100GB NVMe SSD
- Nettverk: 1Gbps

---

## Installasjon

### 1. Grunnleggende Installasjon

```bash
# Klon repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Installer avhengigheter
npm install

# Start
npm start
```

### 2. Docker Installasjon

```bash
# Start med Docker Compose
docker-compose up -d

# Sjekk logger
docker-compose logs -f otedama
```

### 3. Ett-Klikks Installasjon

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

## Konfigurasjon

### Grunnleggende Konfigurasjon

Rediger `otedama.json`:

```json
{
  "pool": {
    "name": "Ditt Pool Navn",
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
    "walletAddress": "Din Lommebokadresse"
  }
}
```

### Kommandolinjekonfigurasjon

```bash
# Grunnleggende oppstart
node index.js --wallet RYourWalletAddress --currency RVN

# Høy ytelse
node index.js --threads 16 --max-miners 5000 --enable-dex

# Tilpassede porter
node index.js --api-port 9080 --stratum-port 4444
```

---

## Miner Tilkobling

### Tilkoblingsinformasjon
- Server: `DIN_IP:3333`
- Brukernavn: `LommebokAdresse.WorkerNavn`
- Passord: `x`

### Mining Programvare Eksempler

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

## Støttede Valutaer

| Valuta | Algoritme | Min. Utbetaling | Avgift |
|--------|-----------|-----------------|--------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Alle valutaer: 1,5% fast avgift (kun driftsavgift) - ikke-modifiserbar

---

## API

### REST Endepunkter

```bash
# Pool statistikk
GET /api/stats

# Avgiftsinnkrevingsstatus
GET /api/fees

# Miner informasjon
GET /api/miners/{minerId}

# DEX priser
GET /api/dex/prices

# Systemhelse
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

## Operatørinformasjon

### Inntektsstruktur

1. **Driftsavgift**: 1,5% fast (ikke-modifiserbar)
2. **DEX Avgift**: 0,3% (distribueres til likviditetsleverandører)
3. **DeFi Avgift**: Del av lånerenten

### Automatiserte Oppgaver

- **Hvert 5. minutt**: Driftsavgift BTC-konvertering og innkreving
- **Hvert 10. minutt**: DEX pool rebalansering
- **Hvert 30. minutt**: DeFi likvidasjonskontroll
- **Hver time**: Automatiske miner betalinger
- **Hver 24. time**: Databaseoptimalisering og sikkerhetskopiering

### Overvåkning

Dashboard: `http://localhost:8080`

Nøkkelmetrikker:
- Aktive minere
- Hashrate
- Avgiftsinntekter
- DEX volum
- Systemressurser

---

## Sikkerhet

### Implementert Beskyttelse

1. **DDoS Beskyttelse**
   - Flerlags hastighetsbegrensning
   - Adaptive terskler
   - Utfordring-respons

2. **Autentiseringssystem**
   - JWT + MFA
   - Rollebasert tilgangskontroll
   - API-nøkkelhåndtering

3. **Manipulasjonsforebygging**
   - Uforanderlig driftsavgiftsadresse
   - Systemintegritetskontroller
   - Revisjonslogger

---

## Feilsøking

### Port I Bruk
```bash
# Sjekk prosess som bruker port
netstat -tulpn | grep :8080

# Stopp prosess
kill -9 PID
```

### Minneproblemer
```bash
# Øk Node.js minnegrense
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Feilsøkingsmodus
```bash
DEBUG=* node index.js
```

---

## Ytelsesoptimalisering

### Optimaliseringsfunksjoner

- **Database Batching**: 70% raskere
- **Nettverksoptimalisering**: 40% båndbreddereduksjon
- **Avansert Caching**: 85%+ treffrate
- **Zero-Copy Operasjoner**: Effektiv miningbehandling

### Benchmark Resultater

```bash
# Kjør benchmark
npm run benchmark

# Resultater (8 kjerner, 16GB RAM):
- Database: 50.000+ ops/sek
- Nettverk: 10.000+ msg/sek
- Cache treffrate: 85%+
- Minnebruk: <100MB (basis)
```

---

## Lisens

MIT Lisens - Kommersiell bruk tillatt

## Støtte

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Fremtiden for Automatisert Mining

---