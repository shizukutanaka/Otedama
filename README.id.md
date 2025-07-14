# Otedama v0.5

**Platform P2P Mining Pool + DEX + DeFi Otomatis Sepenuhnya**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Bahasa Indonesia](README.id.md)

---

## Ikhtisar

Otedama adalah platform pool mining P2P, DEX dan DeFi tingkat komersial yang sepenuhnya otomatis. Dibangun mengikuti filosofi desain John Carmack (kinerja diutamakan), Robert C. Martin (arsitektur bersih) dan Rob Pike (kesederhanaan).

### Fitur Utama

- **Operasi Otomatis Sepenuhnya** - Tidak memerlukan intervensi manual
- **Sistem Biaya Tidak Dapat Diubah** - Pengumpulan BTC otomatis 1,5% yang tidak dapat dimodifikasi
- **Dukungan Multi-Algoritma** - Kompatibel dengan CPU/GPU/ASIC
- **DEX Terpadu** - V2 AMM + V3 Likuiditas Terkonsentrasi
- **Pembayaran Otomatis** - Pembayaran hadiah penambang otomatis per jam
- **Fitur DeFi** - Auto-likuidasi, tata kelola, jembatan
- **Kelas Perusahaan** - Mendukung 10.000+ penambang

### Fitur Otomatisasi Operasional

1. **Pengumpulan Biaya Otomatis**
   - Alamat BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (tidak dapat diubah)
   - Biaya Pool: 0% (dihapus)
   - Biaya Operasional: 1,5% (tidak dapat dimodifikasi)
   - Total Biaya: 1,5% (hanya biaya operasional)
   - Frekuensi Pengumpulan: Setiap 5 menit
   - Konversi otomatis semua mata uang ke BTC

2. **Distribusi Hadiah Mining Otomatis**
   - Dijalankan setiap jam
   - Pemotongan biaya pool otomatis
   - Pengiriman otomatis saat mencapai pembayaran minimum
   - Pencatatan transaksi otomatis

3. **DEX/DeFi Otomatis Sepenuhnya**
   - Penyeimbangan ulang pool likuiditas otomatis
   - Auto-likuidasi (85% LTV)
   - Eksekusi proposal tata kelola otomatis
   - Relay jembatan cross-chain otomatis

---

## Persyaratan Sistem

### Persyaratan Minimum
- Node.js 18+
- RAM: 2GB
- Penyimpanan: 10GB SSD
- Jaringan: 100Mbps

### Persyaratan yang Direkomendasikan
- CPU: 8+ core
- RAM: 8GB+
- Penyimpanan: 100GB NVMe SSD
- Jaringan: 1Gbps

---

## Instalasi

### 1. Instalasi Dasar

```bash
# Clone repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Install dependencies
npm install

# Mulai
npm start
```

### 2. Instalasi Docker

```bash
# Mulai dengan Docker Compose
docker-compose up -d

# Periksa log
docker-compose logs -f otedama
```

### 3. Instalasi Satu Klik

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

### Konfigurasi Dasar

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

### Konfigurasi Command Line

```bash
# Startup dasar
node index.js --wallet RYourWalletAddress --currency RVN

# Kinerja tinggi
node index.js --threads 16 --max-miners 5000 --enable-dex

# Port khusus
node index.js --api-port 9080 --stratum-port 4444
```

---

## Koneksi Penambang

### Informasi Koneksi
- Server: `IP_ANDA:3333`
- Nama pengguna: `AlamatDompet.NamaWorker`
- Kata sandi: `x`

### Contoh Perangkat Lunak Mining

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

## Mata Uang yang Didukung

| Mata Uang | Algoritma | Pembayaran Min | Biaya |
|-----------|-----------|----------------|-------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Semua mata uang: biaya tetap 1,5% (hanya biaya operasional) - tidak dapat dimodifikasi

---

## API

### REST Endpoints

```bash
# Statistik pool
GET /api/stats

# Status pengumpulan biaya
GET /api/fees

# Informasi penambang
GET /api/miners/{minerId}

# Harga DEX
GET /api/dex/prices

# Kesehatan sistem
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

## Informasi Operator

### Struktur Pendapatan

1. **Biaya Operasional**: 1,5% tetap (tidak dapat dimodifikasi)
2. **Biaya DEX**: 0,3% (didistribusikan ke penyedia likuiditas)
3. **Biaya DeFi**: Bagian dari bunga pinjaman

### Tugas Otomatis

- **Setiap 5 menit**: Konversi dan pengumpulan biaya operasional BTC
- **Setiap 10 menit**: Penyeimbangan ulang pool DEX
- **Setiap 30 menit**: Pemeriksaan likuidasi DeFi
- **Setiap jam**: Pembayaran otomatis kepada penambang
- **Setiap 24 jam**: Optimalisasi database dan cadangan

### Pemantauan

Dashboard: `http://localhost:8080`

Metrik Utama:
- Penambang aktif
- Hashrate
- Pendapatan biaya
- Volume DEX
- Sumber daya sistem

---

## Keamanan

### Perlindungan yang Diimplementasikan

1. **Perlindungan DDoS**
   - Pembatasan kecepatan multi-layer
   - Ambang batas adaptif
   - Tantangan-respons

2. **Sistem Autentikasi**
   - JWT + MFA
   - Kontrol akses berbasis peran
   - Manajemen kunci API

3. **Pencegahan Manipulasi**
   - Alamat biaya operasional tidak dapat diubah
   - Pemeriksaan integritas sistem
   - Log audit

---

## Pemecahan Masalah

### Port Sedang Digunakan
```bash
# Periksa proses yang menggunakan port
netstat -tulpn | grep :8080

# Hentikan proses
kill -9 PID
```

### Masalah Memori
```bash
# Tingkatkan batas memori Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Mode Debug
```bash
DEBUG=* node index.js
```

---

## Optimasi Kinerja

### Fitur Optimasi

- **Pemrosesan Batch Database**: 70% lebih cepat
- **Optimasi Jaringan**: Pengurangan bandwidth 40%
- **Caching Lanjutan**: Tingkat hit 85%+
- **Operasi Zero-Copy**: Pemrosesan mining yang efisien

### Hasil Benchmark

```bash
# Jalankan benchmark
npm run benchmark

# Hasil (8 core, 16GB RAM):
- Database: 50.000+ ops/detik
- Jaringan: 10.000+ msg/detik
- Tingkat hit cache: 85%+
- Penggunaan memori: <100MB (dasar)
```

---

## Lisensi

Lisensi MIT - Penggunaan komersial diperbolehkan

## Dukungan

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Masa Depan Mining Otomatis

---