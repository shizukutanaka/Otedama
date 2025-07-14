# Otedama v0.5

**Jukwaa la Uchimbaji wa P2P + DEX + DeFi la Kiotomatiki Kabisa**

### 🌍 Language / Lugha

<details>
<summary><b>Chagua Lugha (Lugha 100 zinazotumika)</b></summary>

[English](README.md) | [Kiswahili](README.sw.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [العربية](README.ar.md) | [Español](README.es.md) | [Français](README.fr.md) | [Tazama lugha zote...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## Muhtasari

Otedama ni jukwaa la kiotomatiki kabisa la uchimbaji wa P2P, DEX na DeFi la kiwango cha kibiashara. Limejengwa kufuatia falsafa za kubuni za John Carmack (utendaji kwanza), Robert C. Martin (usanifu safi) na Rob Pike (urahisi).

### Vipengele Muhimu

- **Uendeshaji wa Kiotomatiki Kabisa** - Hakuna uingiliaji wa mikono unaoitajika
- **Mfumo wa Ada Usiobadilika** - Ukusanyaji wa kiotomatiki wa 0.1% BTC usioweza kubadilishwa
- **Usaidizi wa Kanuni Nyingi** - Inaoana na CPU/GPU/ASIC
- **DEX Iliyounganishwa** - V2 AMM + V3 Ukwasi Uliokolezwa
- **Malipo ya Kiotomatiki** - Malipo ya zawadi za wachimbaji ya kiotomatiki kila saa
- **Vipengele vya DeFi** - Uondoaji wa kiotomatiki, utawala, daraja
- **Kiwango cha Biashara** - Inasaidia wachimbaji 10,000+

### Vipengele vya Otomatiki ya Uendeshaji

1. **Ukusanyaji wa Ada wa Kiotomatiki**
   - Anwani ya BTC: Imewekwa moja kwa moja (haibadiliki)
   - Ada ya dimbwi: 1.4% (haibadiliki)
   - Ada ya uendeshaji: 0.1% (haibadiliki)
   - Jumla ya ada: 1.5% (imara kabisa)
   - Marudio ya ukusanyaji: Kila dakika 5
   - Ubadilishaji wa kiotomatiki wa sarafu zote kuwa BTC

2. **Usambazaji wa Zawadi za Uchimbaji wa Kiotomatiki**
   - Inafanyika kila saa
   - Kukata ada ya dimbwi kiotomatiki
   - Kutuma kiotomatiki wakati malipo ya chini yanafikiwa
   - Kurekodi shughuli kwa kiotomatiki

3. **DEX/DeFi ya Kiotomatiki Kabisa**
   - Kusawazisha upya kwa kiotomatiki kwa madimbwi ya ukwasi
   - Uondoaji wa kiotomatiki (85% LTV)
   - Utekelezaji wa kiotomatiki wa mapendekezo ya utawala
   - Daraja la kiotomatiki la msalaba wa minyororo

---

## Mahitaji ya Mfumo

### Mahitaji ya Chini
- Node.js 18+
- RAM: 2GB
- Hifadhi: 10GB SSD
- Mtandao: 100Mbps

### Mahitaji Yanayopendekezwa
- CPU: Kozi 8+
- RAM: 8GB+
- Hifadhi: 100GB NVMe SSD
- Mtandao: 1Gbps

---

## Ufungaji

### 1. Ufungaji wa Msingi

```bash
# Nakili hazina
git clone https://github.com/otedama/otedama.git
cd otedama

# Funga vitegemezi
npm install

# Anza
npm start
```

### 2. Ufungaji wa Docker

```bash
# Anza kwa Docker Compose
docker-compose up -d

# Angalia kumbukumbu
docker-compose logs -f otedama
```

### 3. Ufungaji wa Bonyeza-Moja

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

## Usanidi

### Usanidi wa Msingi

Hariri `otedama.json`:

```json
{
  "pool": {
    "name": "Jina la Dimbwi Lako",
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
    "walletAddress": "Anwani Yako ya Mkoba"
  }
}
```

### Usanidi wa Mstari wa Amri

```bash
# Uanzishaji wa msingi
node index.js --wallet RYourWalletAddress --currency RVN

# Utendaji wa juu
node index.js --threads 16 --max-miners 5000 --enable-dex

# Bandari maalum
node index.js --api-port 9080 --stratum-port 4444
```

---

## Muunganisho wa Wachimbaji

### Maelezo ya Muunganisho
- Seva: `YOUR_IP:3333`
- Jina la mtumiaji: `WalletAddress.WorkerName`
- Nenosiri: `x`

### Mifano ya Programu za Uchimbaji

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o YOUR_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Sarafu Zinazotumika

| Sarafu | Kanuni | Malipo ya Chini | Ada |
|--------|--------|-----------------|-----|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Sarafu zote: Ada ya 1.5% isiyobadilika (dimbwi 1.4% + uendeshaji 0.1%) - haibadiliki

---

## API

### Mwisho wa REST

```bash
# Takwimu za dimbwi
GET /api/stats

# Hali ya ukusanyaji wa ada
GET /api/fees

# Maelezo ya mchimbaji
GET /api/miners/{minerId}

# Bei za DEX
GET /api/dex/prices

# Afya ya mfumo
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

## Maelezo ya Mwendeshaji

### Muundo wa Mapato

1. **Ada ya dimbwi**: 1.4% imara (haibadiliki)
2. **Ada ya uendeshaji**: 0.1% imara (haibadiliki)
3. **Jumla ya ada ya uchimbaji**: 1.5% (imara kabisa)
4. **Ada ya DEX**: 0.3% (inagawanywa kwa watoa ukwasi)
5. **Ada ya DeFi**: Sehemu ya riba ya mikopo

### Kazi za Kiotomatiki

- **Kila dakika 5**: Ubadilishaji wa ada ya uendeshaji na ukusanyaji wa BTC
- **Kila dakika 10**: Kusawazisha upya kwa madimbwi ya DEX
- **Kila dakika 30**: Kukagua uondoaji wa DeFi
- **Kila saa**: Malipo ya kiotomatiki ya wachimbaji
- **Kila saa 24**: Uboreshaji wa hifadhidata na nakala rudufu

### Ufuatiliaji

Dashibodi: `http://localhost:8080`

Vipimo Muhimu:
- Wachimbaji hai
- Kiwango cha hash
- Mapato ya ada
- Kiasi cha DEX
- Rasilimali za mfumo

---

## Usalama

### Ulinzi Uliotekelezwa

1. **Ulinzi wa DDoS**
   - Kikomo cha kiwango cha tabaka nyingi
   - Vizingiti vinavyobadilika
   - Changamoto-jibu

2. **Mfumo wa Uthibitishaji**
   - JWT + MFA
   - Udhibiti wa ufikiaji kulingana na jukumu
   - Usimamizi wa ufunguo wa API

3. **Kuzuia Uchezaji**
   - Anwani ya ada ya uendeshaji isiobadilika
   - Ukaguzi wa uadilifu wa mfumo
   - Kumbukumbu za ukaguzi

---

## Utatuzi wa Matatizo

### Bandari Inatumika
```bash
# Angalia mchakato unaotumia bandari
netstat -tulpn | grep :8080

# Simamisha mchakato
kill -9 PID
```

### Matatizo ya Kumbukumbu
```bash
# Ongeza kikomo cha kumbukumbu ya Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Hali ya Utatuzi
```bash
DEBUG=* node index.js
```

---

## Uboreshaji wa Utendaji

### Vipengele vya Uboreshaji

- **Mkusanyiko wa Hifadhidata**: Haraka zaidi kwa 70%
- **Uboreshaji wa Mtandao**: Kupunguza kipimo cha mtandao kwa 40%
- **Uhifadhi wa Kiwango cha Juu**: Kiwango cha 85%+ cha mafanikio
- **Shughuli za Nakala-Sifuri**: Uchakataji bora wa uchimbaji

### Matokeo ya Kiwango

```bash
# Endesha kiwango
npm run benchmark

# Matokeo (kozi 8, 16GB RAM):
- Hifadhidata: 50,000+ ops/sekunde
- Mtandao: 10,000+ msg/sekunde
- Kiwango cha mafanikio ya hifadhi: 85%+
- Matumizi ya kumbukumbu: <100MB (msingi)
```

---

## Leseni

Leseni ya MIT - Matumizi ya kibiashara yanaruhusiwa

## Msaada

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Wakati Ujao wa Uchimbaji wa Kiotomatiki

---