# Otedama v0.5

**Plně Automatizovaná P2P Mining Pool + DEX + DeFi Platforma**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Čeština](README.cs.md)

---

## Přehled

Otedama je plně automatizovaná komerční P2P mining pool, DEX a DeFi platforma. Postavená podle designových filozofií Johna Carmacka (výkon na prvním místě), Roberta C. Martina (čistá architektura) a Roba Pikea (jednoduchost).

### Hlavní funkce

- **Plně Automatický Provoz** - Nevyžaduje manuální zásah
- **Neměnný Systém Poplatků** - Nemodifikovatelný automatický výběr 1,5% BTC
- **Podpora Více Algoritmů** - Kompatibilní s CPU/GPU/ASIC
- **Jednotný DEX** - V2 AMM + V3 Koncentrovaná Likvidita
- **Automatická Platba** - Hodinové automatické výplaty odměn těžařům
- **DeFi Funkce** - Auto-likvidace, správa, mosty
- **Enterprise třída** - Podporuje 10 000+ těžařů

### Funkce Provozní Automatizace

1. **Automatický Výběr Poplatků**
   - BTC Adresa: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (neměnná)
   - Poplatek Poolu: 0% (odstraněn)
   - Provozní Poplatek: 1,5% (nemodifikovatelný)
   - Celkový Poplatek: 1,5% (pouze provozní poplatek)
   - Frekvence Výběru: Každých 5 minut
   - Automatická konverze všech měn na BTC

2. **Automatická Distribuce Těžebních Odměn**
   - Provádí se každou hodinu
   - Automatické odečtení poplatků poolu
   - Automatické odeslání při dosažení minimální výplaty
   - Automatické zaznamenávání transakcí

3. **Plně Automatizovaný DEX/DeFi**
   - Automatické vyvažování poolů likvidity
   - Auto-likvidace (85% LTV)
   - Automatické provádění návrhů správy
   - Automatické přeposílání cross-chain mostů

---

## Systémové požadavky

### Minimální požadavky
- Node.js 18+
- RAM: 2GB
- Úložiště: 10GB SSD
- Síť: 100Mbps

### Doporučené požadavky
- CPU: 8+ jader
- RAM: 8GB+
- Úložiště: 100GB NVMe SSD
- Síť: 1Gbps

---

## Instalace

### 1. Základní instalace

```bash
# Klonovat repozitář
git clone https://github.com/otedama/otedama.git
cd otedama

# Nainstalovat závislosti
npm install

# Spustit
npm start
```

### 2. Docker instalace

```bash
# Spustit s Docker Compose
docker-compose up -d

# Zkontrolovat logy
docker-compose logs -f otedama
```

### 3. Instalace jedním kliknutím

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

## Konfigurace

### Základní konfigurace

Upravit `otedama.json`:

```json
{
  "pool": {
    "name": "Název Vašeho Poolu",
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
    "walletAddress": "Vaše Adresa Peněženky"
  }
}
```

### Konfigurace příkazové řádky

```bash
# Základní spuštění
node index.js --wallet RYourWalletAddress --currency RVN

# Vysoký výkon
node index.js --threads 16 --max-miners 5000 --enable-dex

# Vlastní porty
node index.js --api-port 9080 --stratum-port 4444
```

---

## Připojení těžaře

### Informace o připojení
- Server: `VAŠE_IP:3333`
- Uživatelské jméno: `AdresaPeněženky.JménoWorkera`
- Heslo: `x`

### Příklady těžebního softwaru

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://VAŠE_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://VAŠE_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o VAŠE_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Podporované měny

| Měna | Algoritmus | Min. výplata | Poplatek |
|------|------------|--------------|----------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Všechny měny: pevný poplatek 1,5% (pouze provozní poplatek) - nemodifikovatelný

---

## API

### REST Endpoints

```bash
# Statistiky poolu
GET /api/stats

# Stav výběru poplatků
GET /api/fees

# Informace o těžaři
GET /api/miners/{minerId}

# Ceny DEX
GET /api/dex/prices

# Zdraví systému
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

## Informace pro operátory

### Struktura příjmů

1. **Provozní poplatek**: 1,5% pevný (nemodifikovatelný)
2. **DEX poplatek**: 0,3% (distribuován poskytovatelům likvidity)
3. **DeFi poplatek**: Část úroků z půjček

### Automatizované úkoly

- **Každých 5 minut**: Konverze a výběr provozního poplatku BTC
- **Každých 10 minut**: Vyvažování DEX poolu
- **Každých 30 minut**: Kontrola likvidace DeFi
- **Každou hodinu**: Automatické platby těžařům
- **Každých 24 hodin**: Optimalizace databáze a zálohování

### Monitorování

Dashboard: `http://localhost:8080`

Klíčové metriky:
- Aktivní těžaři
- Hashrate
- Příjmy z poplatků
- Objem DEX
- Systémové zdroje

---

## Zabezpečení

### Implementované ochrany

1. **DDoS ochrana**
   - Vícevrstvé omezení rychlosti
   - Adaptivní prahy
   - Výzva-odpověď

2. **Autentizační systém**
   - JWT + MFA
   - Řízení přístupu na základě rolí
   - Správa API klíčů

3. **Prevence manipulace**
   - Neměnná adresa provozního poplatku
   - Kontroly integrity systému
   - Auditní logy

---

## Řešení problémů

### Port je používán
```bash
# Zkontrolovat proces používající port
netstat -tulpn | grep :8080

# Zastavit proces
kill -9 PID
```

### Problémy s pamětí
```bash
# Zvýšit limit paměti Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug režim
```bash
DEBUG=* node index.js
```

---

## Optimalizace výkonu

### Funkce optimalizace

- **Databázové dávkové zpracování**: O 70% rychlejší
- **Síťová optimalizace**: 40% snížení šířky pásma
- **Pokročilé ukládání do mezipaměti**: 85%+ úspěšnost
- **Zero-Copy operace**: Efektivní zpracování těžby

### Výsledky benchmarku

```bash
# Spustit benchmark
npm run benchmark

# Výsledky (8 jader, 16GB RAM):
- Databáze: 50 000+ ops/s
- Síť: 10 000+ msg/s
- Úspěšnost cache: 85%+
- Využití paměti: <100MB (základ)
```

---

## Licence

MIT Licence - Komerční použití povoleno

## Podpora

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Budoucnost automatizované těžby

---