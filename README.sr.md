# Otedama v0.5

**Potpuno Automatizovana P2P Rudarnica + DEX + DeFi Platforma**

### 🌍 Language / Jezik

<details>
<summary><b>Izaberite jezik (100 jezika podržano)</b></summary>

[English](README.md) | [Srpski](README.sr.md) | [Hrvatski](README.hr.md) | [Bosanski](README.bs.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [Русский](README.ru.md) | [Pogledajte sve jezike...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## Pregled

Otedama je potpuno automatizovana komercijalna P2P rudarnica, DEX i DeFi platforma. Izgrađena prema filozofijama dizajna Džona Karmaka (performanse na prvom mestu), Roberta C. Martina (čista arhitektura) i Roba Pajka (jednostavnost).

### Ključne Karakteristike

- **Potpuno Automatizovan Rad** - Nulta potreba za ručnom intervencijom
- **Nepromenljiv Sistem Naknada** - Nepromenljiva automatska naplata 0.1% BTC
- **Podrška za Više Algoritama** - Kompatibilno sa CPU/GPU/ASIC
- **Objedinjeni DEX** - V2 AMM + V3 Koncentrisana Likvidnost
- **Automatska Isplata** - Časovne automatske isplate nagrada rudarima
- **DeFi Funkcije** - Auto-likvidacija, upravljanje, most
- **Nivo Preduzeća** - Podržava 10,000+ rudara

### Karakteristike Operacione Automatizacije

1. **Automatska Naplata Naknada**
   - BTC Adresa: Čvrsto kodovana (nepromenljiva)
   - Naknada rudarske baze: 1.4% (nepromenljiva)
   - Operaciona naknada: 0.1% (nepromenljiva)
   - Ukupna naknada: 1.5% (potpuno fiksna)
   - Učestalost naplate: Svakih 5 minuta
   - Automatska konverzija svih valuta u BTC

2. **Automatska Distribucija Rudarskih Nagrada**
   - Izvršava se svaki sat
   - Automatsko odbijanje naknade baze
   - Automatsko slanje kada se dostigne minimalna isplata
   - Automatsko beleženje transakcija

3. **Potpuno Automatizovan DEX/DeFi**
   - Automatsko rebalansiranje bazena likvidnosti
   - Auto-likvidacija (85% LTV)
   - Automatsko izvršavanje predloga upravljanja
   - Automatsko prosleđivanje mostova između lanaca

---

## Sistemski Zahtevi

### Minimalni Zahtevi
- Node.js 18+
- RAM: 2GB
- Skladište: 10GB SSD
- Mreža: 100Mbps

### Preporučeni Zahtevi
- CPU: 8+ jezgara
- RAM: 8GB+
- Skladište: 100GB NVMe SSD
- Mreža: 1Gbps

---

## Instalacija

### 1. Osnovna Instalacija

```bash
# Klonirajte repozitorijum
git clone https://github.com/otedama/otedama.git
cd otedama

# Instalirajte zavisnosti
npm install

# Pokrenite
npm start
```

### 2. Docker Instalacija

```bash
# Pokrenite sa Docker Compose
docker-compose up -d

# Proverite logove
docker-compose logs -f otedama
```

### 3. Instalacija Jednim Klikom

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

## Konfiguracija

### Osnovna Konfiguracija

Uredite `otedama.json`:

```json
{
  "pool": {
    "name": "Ime Vaše Baze",
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
    "walletAddress": "Vaša Adresa Novčanika"
  }
}
```

### Konfiguracija Komandne Linije

```bash
# Osnovno pokretanje
node index.js --wallet RYourWalletAddress --currency RVN

# Visoke performanse
node index.js --threads 16 --max-miners 5000 --enable-dex

# Prilagođeni portovi
node index.js --api-port 9080 --stratum-port 4444
```

---

## Povezivanje Rudara

### Informacije o Povezivanju
- Server: `VAŠA_IP:3333`
- Korisničko ime: `AdresaNovčanika.ImeRadnika`
- Lozinka: `x`

### Primeri Rudarskog Softvera

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

## Podržane Valute

| Valuta | Algoritam | Min. Isplata | Naknada |
|--------|-----------|--------------|---------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Sve valute: 1.5% fiksna naknada (1.4% baza + 0.1% operacija) - nepromenljivo

---

## API

### REST Krajnje Tačke

```bash
# Statistike baze
GET /api/stats

# Status naplate naknada
GET /api/fees

# Informacije o rudaru
GET /api/miners/{minerId}

# DEX cene
GET /api/dex/prices

# Zdravlje sistema
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

## Informacije za Operatora

### Struktura Prihoda

1. **Naknada Baze**: 1.4% fiksna (nepromenljiva)
2. **Operaciona Naknada**: 0.1% fiksna (nepromenljiva)
3. **Ukupna Rudarska Naknada**: 1.5% (potpuno fiksna)
4. **DEX Naknada**: 0.3% (distribuira se pružaocima likvidnosti)
5. **DeFi Naknada**: Deo kamate na zajmove

### Automatizovani Zadaci

- **Svakih 5 minuta**: Konverzija operacione naknade u BTC i naplata
- **Svakih 10 minuta**: DEX rebalansiranje bazena
- **Svakih 30 minuta**: DeFi provera likvidacije
- **Svaki sat**: Automatske isplate rudarima
- **Svakih 24 sata**: Optimizacija baze podataka i rezervna kopija

### Monitoring

Dashboard: `http://localhost:8080`

Ključne Metrike:
- Aktivni rudari
- Hash stopa
- Prihod od naknada
- DEX obim
- Sistemski resursi

---

## Bezbednost

### Implementirane Zaštite

1. **DDoS Zaštita**
   - Višeslojno ograničavanje brzine
   - Adaptivni pragovi
   - Izazov-odgovor

2. **Sistem Autentifikacije**
   - JWT + MFA
   - Kontrola pristupa bazirana na ulogama
   - Upravljanje API ključevima

3. **Prevencija Manipulacije**
   - Nepromenljiva adresa operacione naknade
   - Provere integriteta sistema
   - Revizijski logovi

---

## Rešavanje Problema

### Port je u Upotrebi
```bash
# Proverite proces koji koristi port
netstat -tulpn | grep :8080

# Zaustavite proces
kill -9 PID
```

### Problemi sa Memorijom
```bash
# Povećajte ograničenje memorije Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug Režim
```bash
DEBUG=* node index.js
```

---

## Optimizacija Performansi

### Karakteristike Optimizacije

- **Grupisanje Baze Podataka**: 70% brže
- **Optimizacija Mreže**: 40% smanjenje propusnog opsega
- **Napredni Keš**: 85%+ stopa pogodaka
- **Zero-Copy Operacije**: Efikasna obrada rudarenja

### Rezultati Benchmark Testa

```bash
# Pokrenite benchmark
npm run benchmark

# Rezultati (8 jezgara, 16GB RAM):
- Baza podataka: 50,000+ ops/sek
- Mreža: 10,000+ msg/sek
- Stopa pogodaka keša: 85%+
- Korišćenje memorije: <100MB (osnova)
```

---

## Licenca

MIT Licenca - Komercijalna upotreba dozvoljena

## Podrška

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Budućnost Automatizovanog Rudarenja

---