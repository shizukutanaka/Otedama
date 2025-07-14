# Otedama v0.5

**Volledig Geautomatiseerd P2P Mining Pool + DEX + DeFi Platform**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Overzicht

Otedama is een volledig geautomatiseerd commercieel P2P mining pool, DEX en DeFi platform. Gebouwd volgens de ontwerpfilosofieën van John Carmack (prestaties eerst), Robert C. Martin (schone architectuur) en Rob Pike (eenvoud).

### Hoofdkenmerken

- **Volledig Automatische Werking** - Geen handmatige interventie vereist
- **Onveranderlijk Tarievensysteem** - Niet-wijzigbare automatische 1,5% BTC-inning
- **Multi-Algoritme Ondersteuning** - CPU/GPU/ASIC compatibel
- **Verenigd DEX** - V2 AMM + V3 Geconcentreerde Liquiditeit
- **Automatische Betaling** - Uurlijkse automatische mijnwerker beloningsbetalingen
- **DeFi Functies** - Auto-liquidatie, governance, bruggen
- **Enterprise Klasse** - Ondersteunt 10.000+ mijnwerkers

### Operationele Automatiseringsfuncties

1. **Automatische Tarieveninning**
   - BTC Adres: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (onveranderlijk)
   - Pool Tarief: 0% (verwijderd)
   - Operationeel Tarief: 1,5% (niet-wijzigbaar)
   - Totaal Tarief: 1,5% (alleen operationeel tarief)
   - Inningsfrequentie: Elke 5 minuten
   - Automatische conversie van alle valuta naar BTC

2. **Automatische Mining Beloningsdistributie**
   - Elk uur uitgevoerd
   - Automatische aftrek van pooltarieven
   - Automatisch verzenden bij bereiken minimale uitbetaling
   - Automatische transactieregistratie

3. **Volledig Geautomatiseerde DEX/DeFi**
   - Automatische herbalancering van liquiditeitspools
   - Auto-liquidatie (85% LTV)
   - Automatische uitvoering van governance voorstellen
   - Automatische relay van cross-chain bruggen

---

## Systeemvereisten

### Minimale Vereisten
- Node.js 18+
- RAM: 2GB
- Opslag: 10GB SSD
- Netwerk: 100Mbps

### Aanbevolen Vereisten
- CPU: 8+ cores
- RAM: 8GB+
- Opslag: 100GB NVMe SSD
- Netwerk: 1Gbps

---

## Installatie

### 1. Basis Installatie

```bash
# Repository klonen
git clone https://github.com/otedama/otedama.git
cd otedama

# Afhankelijkheden installeren
npm install

# Starten
npm start
```

### 2. Docker Installatie

```bash
# Starten met Docker Compose
docker-compose up -d

# Logs controleren
docker-compose logs -f otedama
```

### 3. Een-Klik Installatie

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

## Configuratie

### Basisconfiguratie

Bewerk `otedama.json`:

```json
{
  "pool": {
    "name": "Uw Pool Naam",
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
    "walletAddress": "Uw Wallet Adres"
  }
}
```

### Command Line Configuratie

```bash
# Basis opstarten
node index.js --wallet RYourWalletAddress --currency RVN

# Hoge prestaties
node index.js --threads 16 --max-miners 5000 --enable-dex

# Aangepaste poorten
node index.js --api-port 9080 --stratum-port 4444
```

---

## Mijnwerker Verbinding

### Verbindingsinformatie
- Server: `UW_IP:3333`
- Gebruikersnaam: `WalletAdres.WerkerNaam`
- Wachtwoord: `x`

### Mining Software Voorbeelden

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://UW_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://UW_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o UW_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Ondersteunde Valuta

| Valuta | Algoritme | Min. Uitbetaling | Tarief |
|--------|-----------|------------------|--------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Alle valuta: 1,5% vast tarief (alleen operationeel tarief) - niet-wijzigbaar

---

## API

### REST Eindpunten

```bash
# Pool statistieken
GET /api/stats

# Tarieveninning status
GET /api/fees

# Mijnwerker informatie
GET /api/miners/{minerId}

# DEX prijzen
GET /api/dex/prices

# Systeem gezondheid
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

## Operator Informatie

### Inkomstenstructuur

1. **Operationeel Tarief**: 1,5% vast (niet-wijzigbaar)
2. **DEX Tarief**: 0,3% (verdeeld onder liquiditeitsverschaffers)
3. **DeFi Tarief**: Deel van leenrente

### Geautomatiseerde Taken

- **Elke 5 minuten**: Operationeel tarief BTC conversie en inning
- **Elke 10 minuten**: DEX pool herbalancering
- **Elke 30 minuten**: DeFi liquidatie controle
- **Elk uur**: Automatische mijnwerker betalingen
- **Elke 24 uur**: Database optimalisatie en backup

### Monitoring

Dashboard: `http://localhost:8080`

Belangrijkste Metrieken:
- Actieve mijnwerkers
- Hashrate
- Tariefinkomsten
- DEX volume
- Systeembronnen

---

## Beveiliging

### Geïmplementeerde Bescherming

1. **DDoS Bescherming**
   - Multi-laag snelheidsbeperking
   - Adaptieve drempels
   - Uitdaging-antwoord

2. **Authenticatiesysteem**
   - JWT + MFA
   - Rolgebaseerde toegangscontrole
   - API sleutelbeheer

3. **Manipulatiepreventie**
   - Onveranderlijk operationeel tariefadres
   - Systeemintegriteitscontroles
   - Auditlogs

---

## Probleemoplossing

### Poort In Gebruik
```bash
# Controleer proces dat poort gebruikt
netstat -tulpn | grep :8080

# Stop proces
kill -9 PID
```

### Geheugenproblemen
```bash
# Verhoog Node.js geheugenlimiet
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug Modus
```bash
DEBUG=* node index.js
```

---

## Prestatieoptimalisatie

### Optimalisatiefuncties

- **Database Batching**: 70% sneller
- **Netwerkoptimalisatie**: 40% bandbreedtevermindering
- **Geavanceerd Caching**: 85%+ trefferpercentage
- **Zero-Copy Operaties**: Efficiënte mining verwerking

### Benchmark Resultaten

```bash
# Benchmark uitvoeren
npm run benchmark

# Resultaten (8 cores, 16GB RAM):
- Database: 50.000+ ops/sec
- Netwerk: 10.000+ msg/sec
- Cache trefferpercentage: 85%+
- Geheugengebruik: <100MB (basis)
```

---

## Licentie

MIT Licentie - Commercieel gebruik toegestaan

## Ondersteuning

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - De Toekomst van Geautomatiseerde Mining

---