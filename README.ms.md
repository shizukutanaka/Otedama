# Otedama v0.5

**Platform P2P Mining Pool + DEX + DeFi Automatik Sepenuhnya**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Bahasa Melayu](README.ms.md)

---

## Gambaran Keseluruhan

Otedama ialah platform pool perlombongan P2P, DEX dan DeFi peringkat komersial yang automatik sepenuhnya. Dibina mengikut falsafah reka bentuk John Carmack (prestasi dahulu), Robert C. Martin (seni bina bersih) dan Rob Pike (kesederhanaan).

### Ciri-ciri Utama

- **Operasi Automatik Sepenuhnya** - Tidak memerlukan campur tangan manual
- **Sistem Yuran Tidak Boleh Diubah** - Kutipan BTC automatik 1.5% yang tidak boleh diubahsuai
- **Sokongan Pelbagai Algoritma** - Serasi dengan CPU/GPU/ASIC
- **DEX Bersepadu** - V2 AMM + V3 Kecairan Tertumpu
- **Pembayaran Automatik** - Pembayaran ganjaran pelombong automatik setiap jam
- **Ciri DeFi** - Auto-pembubaran, tadbir urus, jambatan
- **Kelas Perusahaan** - Menyokong 10,000+ pelombong

### Ciri Automasi Operasi

1. **Kutipan Yuran Automatik**
   - Alamat BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (tidak boleh diubah)
   - Yuran Pool: 0% (dihapuskan)
   - Yuran Operasi: 1.5% (tidak boleh diubahsuai)
   - Jumlah Yuran: 1.5% (yuran operasi sahaja)
   - Kekerapan Kutipan: Setiap 5 minit
   - Penukaran automatik semua mata wang kepada BTC

2. **Pengagihan Ganjaran Perlombongan Automatik**
   - Dijalankan setiap jam
   - Potongan yuran pool automatik
   - Penghantaran automatik apabila mencapai pembayaran minimum
   - Rakaman transaksi automatik

3. **DEX/DeFi Automatik Sepenuhnya**
   - Pengimbangan semula pool kecairan automatik
   - Auto-pembubaran (85% LTV)
   - Pelaksanaan cadangan tadbir urus automatik
   - Penyampaian jambatan cross-chain automatik

---

## Keperluan Sistem

### Keperluan Minimum
- Node.js 18+
- RAM: 2GB
- Storan: 10GB SSD
- Rangkaian: 100Mbps

### Keperluan Disyorkan
- CPU: 8+ teras
- RAM: 8GB+
- Storan: 100GB NVMe SSD
- Rangkaian: 1Gbps

---

## Pemasangan

### 1. Pemasangan Asas

```bash
# Klon repositori
git clone https://github.com/otedama/otedama.git
cd otedama

# Pasang kebergantungan
npm install

# Mula
npm start
```

### 2. Pemasangan Docker

```bash
# Mula dengan Docker Compose
docker-compose up -d

# Semak log
docker-compose logs -f otedama
```

### 3. Pemasangan Satu Klik

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

## Konfigurasi

### Konfigurasi Asas

Edit `otedama.json`:

```json
{
  "pool": {
    "name": "Nama Pool Anda",
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
    "walletAddress": "Alamat Dompet Anda"
  }
}
```

### Konfigurasi Baris Arahan

```bash
# Permulaan asas
node index.js --wallet RYourWalletAddress --currency RVN

# Prestasi tinggi
node index.js --threads 16 --max-miners 5000 --enable-dex

# Port tersuai
node index.js --api-port 9080 --stratum-port 4444
```

---

## Sambungan Pelombong

### Maklumat Sambungan
- Pelayan: `IP_ANDA:3333`
- Nama pengguna: `AlamatDompet.NamaPekerja`
- Kata laluan: `x`

### Contoh Perisian Perlombongan

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://IP_ANDA:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://IP_ANDA:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o IP_ANDA:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Mata Wang Disokong

| Mata Wang | Algoritma | Pembayaran Min | Yuran |
|-----------|-----------|----------------|-------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Semua mata wang: yuran tetap 1.5% (yuran operasi sahaja) - tidak boleh diubahsuai

---

## API

### REST Endpoints

```bash
# Statistik pool
GET /api/stats

# Status kutipan yuran
GET /api/fees

# Maklumat pelombong
GET /api/miners/{minerId}

# Harga DEX
GET /api/dex/prices

# Kesihatan sistem
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

## Maklumat Pengendali

### Struktur Hasil

1. **Yuran Operasi**: 1.5% tetap (tidak boleh diubahsuai)
2. **Yuran DEX**: 0.3% (diagihkan kepada pembekal kecairan)
3. **Yuran DeFi**: Sebahagian daripada faedah pinjaman

### Tugas Automatik

- **Setiap 5 minit**: Penukaran dan kutipan yuran operasi BTC
- **Setiap 10 minit**: Pengimbangan semula pool DEX
- **Setiap 30 minit**: Pemeriksaan pembubaran DeFi
- **Setiap jam**: Pembayaran automatik kepada pelombong
- **Setiap 24 jam**: Pengoptimuman pangkalan data dan sandaran

### Pemantauan

Papan Pemuka: `http://localhost:8080`

Metrik Utama:
- Pelombong aktif
- Hashrate
- Hasil yuran
- Volum DEX
- Sumber sistem

---

## Keselamatan

### Perlindungan Dilaksanakan

1. **Perlindungan DDoS**
   - Had kadar berbilang lapisan
   - Ambang adaptif
   - Cabaran-respons

2. **Sistem Pengesahan**
   - JWT + MFA
   - Kawalan akses berasaskan peranan
   - Pengurusan kunci API

3. **Pencegahan Manipulasi**
   - Alamat yuran operasi tidak boleh diubah
   - Pemeriksaan integriti sistem
   - Log audit

---

## Penyelesaian Masalah

### Port Sedang Digunakan
```bash
# Semak proses menggunakan port
netstat -tulpn | grep :8080

# Hentikan proses
kill -9 PID
```

### Masalah Memori
```bash
# Tingkatkan had memori Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Mod Debug
```bash
DEBUG=* node index.js
```

---

## Pengoptimuman Prestasi

### Ciri Pengoptimuman

- **Pemprosesan Kelompok Pangkalan Data**: 70% lebih pantas
- **Pengoptimuman Rangkaian**: Pengurangan lebar jalur 40%
- **Caching Lanjutan**: Kadar hit 85%+
- **Operasi Zero-Copy**: Pemprosesan perlombongan yang cekap

### Keputusan Penanda Aras

```bash
# Jalankan penanda aras
npm run benchmark

# Keputusan (8 teras, 16GB RAM):
- Pangkalan data: 50,000+ ops/saat
- Rangkaian: 10,000+ msg/saat
- Kadar hit cache: 85%+
- Penggunaan memori: <100MB (asas)
```

---

## Lesen

Lesen MIT - Penggunaan komersial dibenarkan

## Sokongan

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Masa Depan Perlombongan Automatik

---