# Otedama v0.5

**Plne Automatizovaná P2P Ťažobná Platforma + DEX + DeFi**

### 🌍 Language / Jazyk

<details>
<summary><b>Vyberte jazyk (podporovaných 100 jazykov)</b></summary>

[English](README.md) | [Slovenčina](README.sk.md) | [Čeština](README.cs.md) | [Polski](README.pl.md) | [Magyar](README.hu.md) | [Deutsch](README.de.md) | [日本語](README.ja.md) | [Zobraziť všetky jazyky...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## Prehľad

Otedama je plne automatizovaná komerčná P2P ťažobná platforma, DEX a DeFi platforma. Postavená podľa dizajnových filozofií Johna Carmacka (výkon na prvom mieste), Roberta C. Martina (čistá architektúra) a Roba Pikea (jednoduchosť).

### Kľúčové Funkcie

- **Plne Automatizovaná Prevádzka** - Nulová potreba manuálnej intervencie
- **Nemenný Systém Poplatkov** - Nezmeniteľný automatický výber 0.1% BTC
- **Podpora Viacerých Algoritmov** - Kompatibilný s CPU/GPU/ASIC
- **Zjednotený DEX** - V2 AMM + V3 Koncentrovaná Likvidita
- **Automatické Platby** - Hodinové automatické platby odmien ťažiarom
- **DeFi Funkcie** - Auto-likvidácia, správa, premostenie
- **Podniková Úroveň** - Podporuje 10,000+ ťažiarov

### Funkcie Operačnej Automatizácie

1. **Automatický Výber Poplatkov**
   - BTC Adresa: Natvrdo kódovaná (nemenná)
   - Poplatok poolu: 1.4% (nezmeniteľný)
   - Prevádzkový poplatok: 0.1% (nezmeniteľný)
   - Celkový poplatok: 1.5% (úplne fixný)
   - Frekvencia výberu: Každých 5 minút
   - Automatická konverzia všetkých mien na BTC

2. **Automatická Distribúcia Odmien za Ťažbu**
   - Vykonáva sa každú hodinu
   - Automatické odpočítanie poplatkov poolu
   - Automatické odoslanie pri dosiahnutí minimálnej výplaty
   - Automatické zaznamenávanie transakcií

3. **Plne Automatizovaný DEX/DeFi**
   - Automatické vyvažovanie poolov likvidity
   - Auto-likvidácia (85% LTV)
   - Automatické vykonávanie návrhov správy
   - Automatické preposielanie cross-chain mostov

---

## Systémové Požiadavky

### Minimálne Požiadavky
- Node.js 18+
- RAM: 2GB
- Úložisko: 10GB SSD
- Sieť: 100Mbps

### Odporúčané Požiadavky
- CPU: 8+ jadier
- RAM: 8GB+
- Úložisko: 100GB NVMe SSD
- Sieť: 1Gbps

---

## Inštalácia

### 1. Základná Inštalácia

```bash
# Naklonovať repozitár
git clone https://github.com/otedama/otedama.git
cd otedama

# Nainštalovať závislosti
npm install

# Spustiť
npm start
```

### 2. Docker Inštalácia

```bash
# Spustiť s Docker Compose
docker-compose up -d

# Skontrolovať logy
docker-compose logs -f otedama
```

### 3. Jednokliková Inštalácia

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

## Konfigurácia

### Základná Konfigurácia

Upravte `otedama.json`:

```json
{
  "pool": {
    "name": "Názov Vášho Poolu",
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
    "walletAddress": "Vaša Adresa Peňaženky"
  }
}
```

### Konfigurácia Príkazového Riadku

```bash
# Základné spustenie
node index.js --wallet RYourWalletAddress --currency RVN

# Vysoký výkon
node index.js --threads 16 --max-miners 5000 --enable-dex

# Vlastné porty
node index.js --api-port 9080 --stratum-port 4444
```

---

## Pripojenie Ťažiara

### Informácie o Pripojení
- Server: `VAŠA_IP:3333`
- Užívateľské meno: `AdresaPeňaženky.MenoWorkera`
- Heslo: `x`

### Príklady Ťažobného Softvéru

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://VAŠA_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://VAŠA_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o VAŠA_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Podporované Meny

| Mena | Algoritmus | Min. Výplata | Poplatok |
|------|------------|--------------|----------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Všetky meny: 1.5% paušálny poplatok (1.4% pool + 0.1% prevádzkový) - nezmeniteľný

---

## API

### REST Koncové Body

```bash
# Štatistiky poolu
GET /api/stats

# Stav výberu poplatkov
GET /api/fees

# Informácie o ťažiarovi
GET /api/miners/{minerId}

# DEX ceny
GET /api/dex/prices

# Zdravie systému
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

## Informácie pre Operátorov

### Štruktúra Príjmov

1. **Poplatok Poolu**: 1.4% fixný (nezmeniteľný)
2. **Prevádzkový Poplatok**: 0.1% fixný (nezmeniteľný)
3. **Celkový Ťažobný Poplatok**: 1.5% (úplne fixný)
4. **DEX Poplatok**: 0.3% (distribuovaný poskytovateľom likvidity)
5. **DeFi Poplatok**: Časť úrokov z pôžičiek

### Automatizované Úlohy

- **Každých 5 minút**: Konverzia prevádzkového poplatku na BTC a výber
- **Každých 10 minút**: Vyvažovanie DEX poolov
- **Každých 30 minút**: Kontrola DeFi likvidácie
- **Každú hodinu**: Automatické platby ťažiarom
- **Každých 24 hodín**: Optimalizácia a zálohovanie databázy

### Monitorovanie

Dashboard: `http://localhost:8080`

Kľúčové Metriky:
- Aktívni ťažiari
- Hash rate
- Príjmy z poplatkov
- DEX objem
- Systémové zdroje

---

## Bezpečnosť

### Implementované Ochrany

1. **DDoS Ochrana**
   - Viacvrstvové obmedzovanie rýchlosti
   - Adaptívne prahy
   - Výzva-odpoveď

2. **Autentifikačný Systém**
   - JWT + MFA
   - Riadenie prístupu na základe rolí
   - Správa API kľúčov

3. **Prevencia Manipulácie**
   - Nemenná adresa prevádzkového poplatku
   - Kontroly integrity systému
   - Auditné logy

---

## Riešenie Problémov

### Port sa Používa
```bash
# Skontrolovať proces používajúci port
netstat -tulpn | grep :8080

# Zastaviť proces
kill -9 PID
```

### Problémy s Pamäťou
```bash
# Zvýšiť limit pamäte Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug Režim
```bash
DEBUG=* node index.js
```

---

## Optimalizácia Výkonu

### Funkcie Optimalizácie

- **Dávkovanie Databázy**: 70% rýchlejšie
- **Sieťová Optimalizácia**: 40% zníženie šírky pásma
- **Pokročilé Cachovanie**: 85%+ úspešnosť
- **Zero-Copy Operácie**: Efektívne spracovanie ťažby

### Výsledky Benchmarku

```bash
# Spustiť benchmark
npm run benchmark

# Výsledky (8 jadier, 16GB RAM):
- Databáza: 50,000+ ops/sek
- Sieť: 10,000+ správ/sek
- Úspešnosť cache: 85%+
- Použitie pamäte: <100MB (základ)
```

---

## Licencia

MIT Licencia - Komerčné použitie povolené

## Podpora

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Budúcnosť Automatizovanej Ťažby

---