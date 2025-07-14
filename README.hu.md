# Otedama v0.5

**Teljesen Automatizált P2P Bányász Pool + DEX + DeFi Platform**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Magyar](README.hu.md)

---

## Áttekintés

Az Otedama egy teljesen automatizált kereskedelmi szintű P2P bányász pool, DEX és DeFi platform. John Carmack (teljesítmény először), Robert C. Martin (tiszta architektúra) és Rob Pike (egyszerűség) tervezési filozófiái szerint épült.

### Főbb jellemzők

- **Teljesen Automatikus Működés** - Nem igényel kézi beavatkozást
- **Megváltoztathatatlan Díjrendszer** - Módosíthatatlan automatikus 1,5% BTC beszedés
- **Több Algoritmus Támogatás** - CPU/GPU/ASIC kompatibilis
- **Egységesített DEX** - V2 AMM + V3 Koncentrált Likviditás
- **Automatikus Kifizetés** - Óránkénti automatikus bányász jutalom kifizetések
- **DeFi Funkciók** - Auto-likvidálás, kormányzás, hidak
- **Vállalati Osztály** - 10.000+ bányász támogatása

### Működési Automatizálási Funkciók

1. **Automatikus Díjbeszedés**
   - BTC Cím: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (megváltoztathatatlan)
   - Pool Díj: 0% (eltávolítva)
   - Működési Díj: 1,5% (módosíthatatlan)
   - Teljes Díj: 1,5% (csak működési díj)
   - Beszedési Gyakoriság: 5 percenként
   - Automatikus konverzió minden valutából BTC-re

2. **Automatikus Bányászati Jutalom Elosztás**
   - Óránként végrehajtva
   - Automatikus pool díj levonás
   - Automatikus küldés a minimális kifizetés elérésekor
   - Automatikus tranzakció rögzítés

3. **Teljesen Automatizált DEX/DeFi**
   - Likviditási poolok automatikus újraegyensúlyozása
   - Auto-likvidálás (85% LTV)
   - Kormányzási javaslatok automatikus végrehajtása
   - Cross-chain hidak automatikus továbbítása

---

## Rendszerkövetelmények

### Minimális követelmények
- Node.js 18+
- RAM: 2GB
- Tárhely: 10GB SSD
- Hálózat: 100Mbps

### Ajánlott követelmények
- CPU: 8+ mag
- RAM: 8GB+
- Tárhely: 100GB NVMe SSD
- Hálózat: 1Gbps

---

## Telepítés

### 1. Alaptelepítés

```bash
# Repository klónozása
git clone https://github.com/otedama/otedama.git
cd otedama

# Függőségek telepítése
npm install

# Indítás
npm start
```

### 2. Docker telepítés

```bash
# Indítás Docker Compose-zal
docker-compose up -d

# Naplók ellenőrzése
docker-compose logs -f otedama
```

### 3. Egy kattintásos telepítés

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

## Konfiguráció

### Alapkonfiguráció

Szerkessze az `otedama.json` fájlt:

```json
{
  "pool": {
    "name": "Az Ön Pool Neve",
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
    "walletAddress": "Az Ön Pénztárca Címe"
  }
}
```

### Parancssori konfiguráció

```bash
# Alapindítás
node index.js --wallet RYourWalletAddress --currency RVN

# Nagy teljesítmény
node index.js --threads 16 --max-miners 5000 --enable-dex

# Egyéni portok
node index.js --api-port 9080 --stratum-port 4444
```

---

## Bányász Kapcsolat

### Kapcsolati információk
- Szerver: `AZ_ÖN_IP:3333`
- Felhasználónév: `PénztárcaCím.WorkerNév`
- Jelszó: `x`

### Bányász szoftver példák

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://AZ_ÖN_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://AZ_ÖN_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o AZ_ÖN_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Támogatott Valuták

| Valuta | Algoritmus | Min. Kifizetés | Díj |
|--------|------------|----------------|-----|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Minden valuta: 1,5% fix díj (csak működési díj) - módosíthatatlan

---

## API

### REST Végpontok

```bash
# Pool statisztikák
GET /api/stats

# Díjbeszedési állapot
GET /api/fees

# Bányász információk
GET /api/miners/{minerId}

# DEX árak
GET /api/dex/prices

# Rendszer állapot
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

## Üzemeltető Információk

### Bevételi Struktúra

1. **Működési Díj**: 1,5% fix (módosíthatatlan)
2. **DEX Díj**: 0,3% (likviditás szolgáltatóknak szétosztva)
3. **DeFi Díj**: Hitelkamat egy része

### Automatizált Feladatok

- **5 percenként**: Működési díj BTC konverzió és beszedés
- **10 percenként**: DEX pool újraegyensúlyozás
- **30 percenként**: DeFi likvidálási ellenőrzés
- **Óránként**: Automatikus bányász kifizetések
- **24 óránként**: Adatbázis optimalizálás és mentés

### Monitorozás

Vezérlőpult: `http://localhost:8080`

Kulcs Metrikák:
- Aktív bányászok
- Hashrate
- Díjbevételek
- DEX volumen
- Rendszer erőforrások

---

## Biztonság

### Megvalósított Védelmek

1. **DDoS Védelem**
   - Többrétegű sebességkorlátozás
   - Adaptív küszöbértékek
   - Kihívás-válasz

2. **Hitelesítési Rendszer**
   - JWT + MFA
   - Szerepkör alapú hozzáférés-vezérlés
   - API kulcs kezelés

3. **Manipuláció Megelőzés**
   - Megváltoztathatatlan működési díj cím
   - Rendszer integritás ellenőrzések
   - Audit naplók

---

## Hibaelhárítás

### Port Használatban
```bash
# Portot használó folyamat ellenőrzése
netstat -tulpn | grep :8080

# Folyamat leállítása
kill -9 PID
```

### Memória Problémák
```bash
# Node.js memória limit növelése
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug Mód
```bash
DEBUG=* node index.js
```

---

## Teljesítmény Optimalizálás

### Optimalizálási Funkciók

- **Adatbázis Kötegelés**: 70%-kal gyorsabb
- **Hálózat Optimalizálás**: 40% sávszélesség csökkentés
- **Fejlett Gyorsítótárazás**: 85%+ találati arány
- **Zero-Copy Műveletek**: Hatékony bányászat feldolgozás

### Benchmark Eredmények

```bash
# Benchmark futtatása
npm run benchmark

# Eredmények (8 mag, 16GB RAM):
- Adatbázis: 50.000+ ops/mp
- Hálózat: 10.000+ üzenet/mp
- Cache találati arány: 85%+
- Memória használat: <100MB (alap)
```

---

## Licenc

MIT Licenc - Kereskedelmi használat engedélyezett

## Támogatás

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Az Automatizált Bányászat Jövője

---