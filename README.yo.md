# Otedama v0.5

**Ikopa P2P Mining Pool + DEX + DeFi Platform Ti O Ṣiṣẹ Funrarẹ Patapata**

### 🌍 Language / Èdè

<details>
<summary><b>Yan Èdè (Èdè 100 ni a ṣe atilẹyin fun)</b></summary>

[English](README.md) | [Yorùbá](README.yo.md) | [Hausa](README.ha.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [العربية](README.ar.md) | [Wo gbogbo àwọn èdè...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषا--dil--язык)

</details>

---

## Akopọ

Otedama jẹ ikopa P2P mining pool, DEX ati DeFi platform ti o ṣiṣẹ funrarẹ patapata ti ipele iṣowo. A kọ o ni ibamu pẹlu awọn imọ-jinlẹ apẹrẹ ti John Carmack (iṣẹ ṣiṣe ni akọkọ), Robert C. Martin (faaji mọ) ati Rob Pike (irọrun).

### Awọn Ẹya Pataki

- **Iṣẹ Ti O Ṣiṣẹ Funrarẹ Patapata** - Ko nilo idasi ọwọ rara
- **Eto Idiyele Ti Ko Le Yipada** - Gbigba 0.1% BTC ti o ṣiṣẹ funrarẹ ti ko le yipada
- **Atilẹyin Algorithm Pupọ** - Ibamu pẹlu CPU/GPU/ASIC
- **DEX Ti A Papọ** - V2 AMM + V3 Concentrated Liquidity
- **Isanwo Laifọwọyi** - Awọn isanwo ẹbun awọn oluwakole ni wakati kọọkan
- **Awọn Ẹya DeFi** - Ifọkanbalẹ laifọwọyi, iṣakoso, afara
- **Ipele Ile-iṣẹ** - N ṣe atilẹyin fun awọn oluwakole 10,000+

### Awọn Ẹya Iṣẹ Ṣiṣe Laifọwọyi

1. **Gbigba Idiyele Laifọwọyi**
   - Adirẹsi BTC: Ti kọ sinu koodu (ko le yipada)
   - Idiyele pool: 1.4% (ko le yipada)
   - Idiyele iṣẹ: 0.1% (ko le yipada)
   - Apapọ idiyele: 1.5% (ti o wa titi)
   - Igba gbigba: Ni iṣẹju 5 kọọkan
   - Iyipada laifọwọyi ti gbogbo owo si BTC

2. **Pinpin Ẹbun Iwakole Laifọwọyi**
   - N ṣiṣẹ ni wakati kọọkan
   - Yọkuro idiyele pool laifọwọyi
   - Fifiranṣẹ laifọwọyi nigbati o ba de isanwo to kere julọ
   - Igbasilẹ idunadura laifọwọyi

3. **DEX/DeFi Ti O Ṣiṣẹ Funrarẹ Patapata**
   - Atunṣe awọn pool omi laifọwọyi
   - Ifọkanbalẹ laifọwọyi (85% LTV)
   - Ṣiṣe awọn imọran iṣakoso laifọwọyi
   - Gbigbe awọn afara agbelebu-ẹrọ laifọwọyi

---

## Awọn Ibeere Eto

### Awọn Ibeere To Kere Julọ
- Node.js 18+
- RAM: 2GB
- Ibi ipamọ: 10GB SSD
- Nẹtiwọọki: 100Mbps

### Awọn Ibeere Ti A Ṣeduro
- CPU: 8+ cores
- RAM: 8GB+
- Ibi ipamọ: 100GB NVMe SSD
- Nẹtiwọọki: 1Gbps

---

## Fifi Sori Ẹrọ

### 1. Fifi Sori Ẹrọ Ipilẹ

```bash
# Ṣe ẹda ibi ipamọ
git clone https://github.com/otedama/otedama.git
cd otedama

# Fi awọn igbekalẹ sii
npm install

# Bẹrẹ
npm start
```

### 2. Fifi Docker Sori Ẹrọ

```bash
# Bẹrẹ pẹlu Docker Compose
docker-compose up -d

# Wo awọn akọọlẹ
docker-compose logs -f otedama
```

### 3. Fifi Sori Ẹrọ Titẹ-Kan

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

## Iṣeto

### Iṣeto Ipilẹ

Ṣatunkọ `otedama.json`:

```json
{
  "pool": {
    "name": "Orukọ Pool Rẹ",
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
    "walletAddress": "Adirẹsi Apamọwọ Rẹ"
  }
}
```

### Iṣeto Ila Aṣẹ

```bash
# Ibẹrẹ ipilẹ
node index.js --wallet RYourWalletAddress --currency RVN

# Iṣẹ ṣiṣe giga
node index.js --threads 16 --max-miners 5000 --enable-dex

# Awọn ibudo adani
node index.js --api-port 9080 --stratum-port 4444
```

---

## Asopọ Oluwakole

### Alaye Asopọ
- Olupin: `YOUR_IP:3333`
- Orukọ olumulo: `WalletAddress.WorkerName`
- Ọrọ igbaniwọle: `x`

### Awọn Apẹẹrẹ Software Iwakole

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

## Awọn Owo Ti A Ṣe Atilẹyin Fun

| Owo | Algorithm | Isanwo To Kere Julọ | Idiyele |
|-----|-----------|---------------------|---------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Gbogbo owo: idiyele deede 1.5% (pool 1.4% + iṣẹ 0.1%) - ko le yipada

---

## API

### Awọn Opin REST

```bash
# Awọn iṣiro pool
GET /api/stats

# Ipo gbigba idiyele
GET /api/fees

# Alaye oluwakole
GET /api/miners/{minerId}

# Awọn idiyele DEX
GET /api/dex/prices

# Ilera eto
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

## Alaye Oniṣẹ

### Eto Owo Wiwọle

1. **Idiyele Pool**: 1.4% ti o wa titi (ko le yipada)
2. **Idiyele Iṣẹ**: 0.1% ti o wa titi (ko le yipada)
3. **Apapọ Idiyele Iwakole**: 1.5% (ti o wa titi patapata)
4. **Idiyele DEX**: 0.3% (pinpin si awọn olupese omi)
5. **Idiyele DeFi**: Apakan ti ere awin

### Awọn Iṣẹ Laifọwọyi

- **Ni iṣẹju 5 kọọkan**: Iyipada idiyele iṣẹ BTC ati gbigba
- **Ni iṣẹju 10 kọọkan**: Atunṣe awọn pool DEX
- **Ni iṣẹju 30 kọọkan**: Ayẹwo ifọkanbalẹ DeFi
- **Ni wakati kọọkan**: Awọn isanwo oluwakole laifọwọyi
- **Ni wakati 24 kọọkan**: Iṣapeye data-olupilẹṣẹ ati afẹyinti

### Abojuto

Dashboard: `http://localhost:8080`

Awọn Iwọn Pataki:
- Awọn oluwakole ti nṣiṣẹ
- Oṣuwọn hash
- Owo wiwọle idiyele
- Iwọn DEX
- Awọn ohun elo eto

---

## Aabo

### Awọn Aabo Ti A Ti Ṣe

1. **Aabo DDoS**
   - Idiwọn oṣuwọn ọpọlọpọ
   - Awọn ala ti o le yipada
   - Ibeere-idahun

2. **Eto Ijẹrisi**
   - JWT + MFA
   - Iṣakoso wiwọle ti o da lori ipa
   - Iṣakoso bọtini API

3. **Idena Ibajẹ**
   - Adirẹsi idiyele iṣẹ ti ko le yipada
   - Awọn ayẹwo iduroṣinṣin eto
   - Awọn akọọlẹ ayẹwo

---

## Ipinnu Awọn Iṣoro

### Ibudo Ti N Lo
```bash
# Wo ilana ti n lo ibudo
netstat -tulpn | grep :8080

# Da ilana duro
kill -9 PID
```

### Awọn Iṣoro Iranti
```bash
# Mu opin iranti Node.js pọ si
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Ipo Ṣiṣayẹwo
```bash
DEBUG=* node index.js
```

---

## Imudara Iṣẹ Ṣiṣe

### Awọn Ẹya Imudara

- **Ikojọpọ Data-olupilẹṣẹ**: 70% yiyara sii
- **Imudara Nẹtiwọọki**: Idinku bandwidth 40%
- **Kaṣe to ga julọ**: Oṣuwọn aṣeyọri 85%+
- **Awọn iṣẹ Zero-Copy**: Ṣiṣe iwakole to munadoko

### Awọn Abajade Idanwo

```bash
# Ṣe idanwo
npm run benchmark

# Awọn abajade (8 cores, 16GB RAM):
- Data-olupilẹṣẹ: 50,000+ ops/iṣẹju-aaya
- Nẹtiwọọki: 10,000+ msg/iṣẹju-aaya
- Oṣuwọn aṣeyọri kaṣe: 85%+
- Lilo iranti: <100MB (ipilẹ)
```

---

## Iwe-aṣẹ

Iwe-aṣẹ MIT - Lilo iṣowo ti gba laaye

## Atilẹyin

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Ọjọ Iwaju Ti Iwakole Laifọwọyi

---