# Otedama v0.5

**Platformă P2P Mining Pool + DEX + DeFi Complet Automatizată**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Română](README.ro.md)

---

## Prezentare Generală

Otedama este o platformă comercială de pool de mining P2P, DEX și DeFi complet automatizată. Construită după filozofiile de design ale lui John Carmack (performanța pe primul loc), Robert C. Martin (arhitectură curată) și Rob Pike (simplitate).

### Caracteristici Principale

- **Operare Complet Automată** - Nu necesită intervenție manuală
- **Sistem de Taxe Imuabil** - Colectare automată nemodificabilă de 1,5% BTC
- **Suport Multi-Algoritm** - Compatibil cu CPU/GPU/ASIC
- **DEX Unificat** - V2 AMM + V3 Lichiditate Concentrată
- **Plată Automată** - Plăți automate orare ale recompenselor minerilor
- **Funcții DeFi** - Auto-lichidare, guvernanță, poduri
- **Clasă Enterprise** - Suportă 10.000+ mineri

### Caracteristici de Automatizare Operațională

1. **Colectare Automată a Taxelor**
   - Adresă BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (imuabilă)
   - Taxa Pool: 0% (eliminată)
   - Taxa Operațională: 1,5% (nemodificabilă)
   - Taxa Totală: 1,5% (doar taxa operațională)
   - Frecvența Colectării: La fiecare 5 minute
   - Conversie automată a tuturor monedelor în BTC

2. **Distribuție Automată a Recompenselor de Mining**
   - Executată la fiecare oră
   - Deducere automată a taxelor pool
   - Trimitere automată la atingerea plății minime
   - Înregistrare automată a tranzacțiilor

3. **DEX/DeFi Complet Automatizat**
   - Reechilibrare automată a pool-urilor de lichiditate
   - Auto-lichidare (85% LTV)
   - Execuție automată a propunerilor de guvernanță
   - Retransmitere automată a podurilor cross-chain

---

## Cerințe de Sistem

### Cerințe Minime
- Node.js 18+
- RAM: 2GB
- Stocare: 10GB SSD
- Rețea: 100Mbps

### Cerințe Recomandate
- CPU: 8+ nuclee
- RAM: 8GB+
- Stocare: 100GB NVMe SSD
- Rețea: 1Gbps

---

## Instalare

### 1. Instalare de Bază

```bash
# Clonare repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Instalare dependențe
npm install

# Pornire
npm start
```

### 2. Instalare Docker

```bash
# Pornire cu Docker Compose
docker-compose up -d

# Verificare log-uri
docker-compose logs -f otedama
```

### 3. Instalare cu Un Click

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

## Configurare

### Configurare de Bază

Editați `otedama.json`:

```json
{
  "pool": {
    "name": "Numele Pool-ului Dvs",
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
    "walletAddress": "Adresa Portofelului Dvs"
  }
}
```

### Configurare Linie de Comandă

```bash
# Pornire de bază
node index.js --wallet RYourWalletAddress --currency RVN

# Performanță înaltă
node index.js --threads 16 --max-miners 5000 --enable-dex

# Porturi personalizate
node index.js --api-port 9080 --stratum-port 4444
```

---

## Conexiune Miner

### Informații de Conexiune
- Server: `IP_DVS:3333`
- Nume utilizator: `AdresăPortofel.NumeWorker`
- Parolă: `x`

### Exemple Software de Mining

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://IP_DVS:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://IP_DVS:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o IP_DVS:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Monede Suportate

| Monedă | Algoritm | Plată Min | Taxa |
|--------|----------|-----------|------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Toate monedele: taxă fixă 1,5% (doar taxa operațională) - nemodificabilă

---

## API

### Endpoint-uri REST

```bash
# Statistici pool
GET /api/stats

# Status colectare taxe
GET /api/fees

# Informații miner
GET /api/miners/{minerId}

# Prețuri DEX
GET /api/dex/prices

# Sănătate sistem
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

## Informații pentru Operatori

### Structura Veniturilor

1. **Taxa Operațională**: 1,5% fixă (nemodificabilă)
2. **Taxa DEX**: 0,3% (distribuită furnizorilor de lichiditate)
3. **Taxa DeFi**: Parte din dobânzile la împrumuturi

### Sarcini Automatizate

- **La fiecare 5 minute**: Conversie și colectare taxă operațională BTC
- **La fiecare 10 minute**: Reechilibrare pool DEX
- **La fiecare 30 minute**: Verificare lichidare DeFi
- **La fiecare oră**: Plăți automate către mineri
- **La fiecare 24 ore**: Optimizare bază de date și backup

### Monitorizare

Tablou de Bord: `http://localhost:8080`

Metrici Cheie:
- Mineri activi
- Hashrate
- Venituri din taxe
- Volum DEX
- Resurse sistem

---

## Securitate

### Protecții Implementate

1. **Protecție DDoS**
   - Limitare de rată pe mai multe niveluri
   - Praguri adaptive
   - Provocare-răspuns

2. **Sistem de Autentificare**
   - JWT + MFA
   - Control acces bazat pe roluri
   - Management chei API

3. **Prevenirea Manipulării**
   - Adresă taxă operațională imuabilă
   - Verificări integritate sistem
   - Jurnale de audit

---

## Depanare

### Port în Utilizare
```bash
# Verificare proces care folosește portul
netstat -tulpn | grep :8080

# Oprire proces
kill -9 PID
```

### Probleme de Memorie
```bash
# Creștere limită memorie Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Mod Debug
```bash
DEBUG=* node index.js
```

---

## Optimizare Performanță

### Funcții de Optimizare

- **Procesare în Lot Bază de Date**: Cu 70% mai rapid
- **Optimizare Rețea**: Reducere lățime de bandă 40%
- **Cache Avansat**: Rată de succes 85%+
- **Operațiuni Zero-Copy**: Procesare eficientă mining

### Rezultate Benchmark

```bash
# Rulare benchmark
npm run benchmark

# Rezultate (8 nuclee, 16GB RAM):
- Bază de date: 50.000+ ops/sec
- Rețea: 10.000+ msg/sec
- Rată succes cache: 85%+
- Utilizare memorie: <100MB (bază)
```

---

## Licență

Licență MIT - Utilizare comercială permisă

## Suport

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Viitorul Mining-ului Automatizat

---