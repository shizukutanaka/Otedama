# Otedama v0.5

**Täysin Automatisoitu P2P Louhintapooli + DEX + DeFi Alusta**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Suomi](README.fi.md)

---

## Yleiskatsaus

Otedama on täysin automatisoitu kaupallisen tason P2P louhintapooli, DEX ja DeFi alusta. Rakennettu John Carmackin (suorituskyky ensin), Robert C. Martinin (puhdas arkkitehtuuri) ja Rob Piken (yksinkertaisuus) suunnittelufilosofioiden mukaan.

### Pääominaisuudet

- **Täysin Automaattinen Toiminta** - Ei vaadi manuaalista väliintuloa
- **Muuttumaton Maksujärjestelmä** - Muokkaamaton automaattinen 1,5% BTC-keräys
- **Monialgoritmituki** - CPU/GPU/ASIC yhteensopiva
- **Yhdistetty DEX** - V2 AMM + V3 Keskitetty Likviditeetti
- **Automaattinen Maksu** - Tunneittaiset automaattiset louhijoiden palkkiomaksut
- **DeFi Ominaisuudet** - Automaattinen realisointi, hallinto, sillat
- **Yritystaso** - Tukee 10 000+ louhijaa

### Toiminnalliset Automatisointiominaisuudet

1. **Automaattinen Maksujen Keräys**
   - BTC Osoite: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (muuttumaton)
   - Poolimaksu: 0% (poistettu)
   - Toimintamaksu: 1,5% (muokkaamaton)
   - Kokonaismaksu: 1,5% (vain toimintamaksu)
   - Keräystiheys: 5 minuutin välein
   - Automaattinen kaikkien valuuttojen muuntaminen BTC:ksi

2. **Automaattinen Louhintapalkkioiden Jakelu**
   - Suoritetaan tunneittain
   - Automaattinen poolimaksujen vähennys
   - Automaattinen lähetys vähimmäismaksun saavuttaessa
   - Automaattinen transaktioiden tallennus

3. **Täysin Automatisoitu DEX/DeFi**
   - Likviditeettialtaiden automaattinen tasapainotus
   - Automaattinen realisointi (85% LTV)
   - Hallintaehdotusten automaattinen toteutus
   - Cross-chain siltojen automaattinen välitys

---

## Järjestelmävaatimukset

### Vähimmäisvaatimukset
- Node.js 18+
- RAM: 2GB
- Tallennustila: 10GB SSD
- Verkko: 100Mbps

### Suositellut Vaatimukset
- CPU: 8+ ydintä
- RAM: 8GB+
- Tallennustila: 100GB NVMe SSD
- Verkko: 1Gbps

---

## Asennus

### 1. Perusasennus

```bash
# Kloonaa repositorio
git clone https://github.com/otedama/otedama.git
cd otedama

# Asenna riippuvuudet
npm install

# Käynnistä
npm start
```

### 2. Docker Asennus

```bash
# Käynnistä Docker Composella
docker-compose up -d

# Tarkista lokit
docker-compose logs -f otedama
```

### 3. Yhden Klikkauksen Asennus

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

## Konfigurointi

### Peruskonfiguraatio

Muokkaa `otedama.json`:

```json
{
  "pool": {
    "name": "Poolisi Nimi",
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
    "walletAddress": "Lompakkoosoitteesi"
  }
}
```

### Komentorivin Konfiguraatio

```bash
# Peruskäynnistys
node index.js --wallet RYourWalletAddress --currency RVN

# Korkea suorituskyky
node index.js --threads 16 --max-miners 5000 --enable-dex

# Mukautetut portit
node index.js --api-port 9080 --stratum-port 4444
```

---

## Louhijan Yhteys

### Yhteystiedot
- Palvelin: `SINUN_IP:3333`
- Käyttäjänimi: `LompakkoOsoite.WorkerNimi`
- Salasana: `x`

### Louhintaohjelmistoesimerkit

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://SINUN_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://SINUN_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o SINUN_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Tuetut Valuutat

| Valuutta | Algoritmi | Min. Maksu | Maksu |
|----------|-----------|------------|-------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Kaikki valuutat: 1,5% kiinteä maksu (vain toimintamaksu) - muokkaamaton

---

## API

### REST Päätepisteet

```bash
# Poolin tilastot
GET /api/stats

# Maksujen keräyksen tila
GET /api/fees

# Louhijan tiedot
GET /api/miners/{minerId}

# DEX hinnat
GET /api/dex/prices

# Järjestelmän terveys
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

## Operaattoritiedot

### Tulorakenne

1. **Toimintamaksu**: 1,5% kiinteä (muokkaamaton)
2. **DEX Maksu**: 0,3% (jaetaan likviditeetin tarjoajille)
3. **DeFi Maksu**: Osa lainakoroista

### Automatisoidut Tehtävät

- **5 minuutin välein**: Toimintamaksun BTC-muunnos ja keräys
- **10 minuutin välein**: DEX poolin tasapainotus
- **30 minuutin välein**: DeFi realisointitarkistus
- **Tunneittain**: Automaattiset louhijamaksut
- **24 tunnin välein**: Tietokannan optimointi ja varmuuskopiointi

### Valvonta

Kojelauta: `http://localhost:8080`

Avainmittarit:
- Aktiiviset louhijat
- Hashrate
- Maksutulot
- DEX volyymi
- Järjestelmäresurssit

---

## Turvallisuus

### Toteutetut Suojaukset

1. **DDoS Suojaus**
   - Monitasoinen nopeusrajoitus
   - Mukautuvat kynnysarvot
   - Haaste-vastaus

2. **Todennusjärjestelmä**
   - JWT + MFA
   - Roolipohjainen pääsynhallinta
   - API-avainten hallinta

3. **Manipuloinnin Esto**
   - Muuttumaton toimintamaksuosoite
   - Järjestelmän eheyden tarkistukset
   - Tarkastuslokit

---

## Vianmääritys

### Portti Käytössä
```bash
# Tarkista porttia käyttävä prosessi
netstat -tulpn | grep :8080

# Pysäytä prosessi
kill -9 PID
```

### Muistiongelmat
```bash
# Kasvata Node.js muistirajaa
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Virheenkorjaustila
```bash
DEBUG=* node index.js
```

---

## Suorituskyvyn Optimointi

### Optimointiominaisuudet

- **Tietokannan Eräkäsittely**: 70% nopeampi
- **Verkko-optimointi**: 40% kaistanleveyden vähennys
- **Edistynyt Välimuisti**: 85%+ osumataajuus
- **Zero-Copy Toiminnot**: Tehokas louhintakäsittely

### Vertailuarvotulokset

```bash
# Suorita vertailuarvo
npm run benchmark

# Tulokset (8 ydintä, 16GB RAM):
- Tietokanta: 50 000+ ops/sek
- Verkko: 10 000+ msg/sek
- Välimuistin osumataajuus: 85%+
- Muistin käyttö: <100MB (perus)
```

---

## Lisenssi

MIT Lisenssi - Kaupallinen käyttö sallittu

## Tuki

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Automatisoidun Louhinnan Tulevaisuus

---