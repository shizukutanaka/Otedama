# Otedama - Kolam Perlombongan P2P dan Perisian Perlombongan Perusahaan

**Versi**: 2.1.6  
**Lesen**: MIT  
**Versi Go**: 1.21+  
**Seni Bina**: Perkhidmatan mikro dengan sokongan kolam P2P  
**Tarikh Keluaran**: 6 Ogos 2025

Otedama ialah kolam perlombongan P2P dan perisian perlombongan gred perusahaan yang direka untuk kecekapan dan kebolehpercayaan maksimum. Dibina mengikut prinsip reka bentuk John Carmack (prestasi), Robert C. Martin (seni bina bersih) dan Rob Pike (kesederhanaan), menyokong perlombongan CPU/GPU/ASIC komprehensif dengan skalabilitas peringkat nasional.

## Seni Bina

### Kolam Perlombongan P2P
- **Pengurusan Kolam Teragih**: Kolam perlombongan teragih dengan failover automatik
- **Pengagihan Ganjaran**: Algoritma PPS/PPLNS canggih dengan sokongan berbilang mata wang
- **Protokol Persekutuan**: Komunikasi antara kolam untuk ketahanan yang dipertingkatkan
- **Pemantauan Peringkat Kebangsaan**: Pemantauan perusahaan yang sesuai untuk pelaksanaan kerajaan

### Ciri Perlombongan
- **Pelbagai Algoritma**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Perkakasan Universal**: Dioptimumkan untuk CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Canggih**: Sokongan penuh v1/v2 dengan sambungan untuk pelombong prestasi tinggi
- **Pengoptimuman Sifar-Salinan**: Struktur data sedar cache dan memori sedar NUMA

### Ciri Perusahaan
- **Sedia Pengeluaran**: Pelaksanaan Docker/Kubernetes dengan penskalaan automatik
- **Keselamatan Perusahaan**: Perlindungan DDoS, pengehadan kadar, pengauditan menyeluruh
- **Ketersediaan Tinggi**: Persediaan berbilang nod dengan failover automatik
- **Analitik Masa Nyata**: API WebSocket dengan integrasi papan pemuka langsung

## Keperluan

- Go 1.21 atau lebih tinggi
- Linux, macOS, Windows
- Perkakasan perlombongan (CPU/GPU/ASIC)
- Sambungan rangkaian ke kolam perlombongan

## Pemasangan

### Dari sumber

```bash
# Bina dalam direktori sumber
cd Otedama

# Bina binari
make build

# Pasang ke sistem
make install
```

### Menggunakan Go Build

```bash
go build ./cmd/otedama
```

### Docker Pengeluaran

```bash
# Pelaksanaan pengeluaran
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Laksanakan tumpukan penuh
kubectl apply -f k8s/
```

## Permulaan Pantas

### 1. Konfigurasi

```yaml
# Konfigurasi pengeluaran dengan sokongan kolam P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Pengesanan automatik
    priority: "normal"
  
  gpu:
    devices: [] # Kesan semua peranti secara automatik
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Penemuan automatik
    poll_interval: 5s

pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 10000
  fee_percentage: 1.0
  rewards:
    system: "PPLNS"
    window: 2h

api:
  enable: true
  address: "0.0.0.0:8080"
  auth:
    enabled: true
    token_expiry: 24h

monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
  health:
    enabled: true
    address: "0.0.0.0:8081"
```

### 2. Pilihan Pelaksanaan

```bash
# Pembangunan
./otedama serve --config config.yaml

# Docker Pengeluaran
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Perusahaan
kubectl apply -f k8s/

# Pelaksanaan pengeluaran manual
sudo ./scripts/production-deploy.sh
```

### 3. Pemantauan Prestasi

```bash
# Semak status
./otedama status

# Lihat log
tail -f logs/otedama.log

# Titik akhir API
curl http://localhost:8080/api/status
```

## Prestasi

Otedama dioptimumkan untuk kecekapan maksimum:

- **Penggunaan Memori**: Dioptimumkan untuk jejak memori minimum
- **Saiz Binari**: Saiz padat (~15MB)
- **Masa Permulaan**: <500ms
- **Overhed CPU**: <1% untuk pemantauan

## Rujukan API

### Titik Akhir REST

- `GET /api/status` - Status perlombongan
- `GET /api/stats` - Statistik terperinci
- `GET /api/workers` - Maklumat pekerja
- `POST /api/mining/start` - Mula perlombongan
- `POST /api/mining/stop` - Henti perlombongan

### WebSocket

Sambung ke `ws://localhost:8080/api/ws` untuk kemas kini masa nyata.

## Pelaksanaan

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    build: .
    volumes:
      - ./config.yaml:/config.yaml
    ports:
      - "8080:8080"
      - "3333:3333"
    restart: unless-stopped
```

### Kubernetes

```bash
kubectl apply -f k8s/
```

## Sumbangan

Sumbangan dialu-alukan! Sila ikuti amalan pembangunan standard:

1. Cipta cawangan ciri
2. Buat perubahan
3. Uji secara menyeluruh
4. Hantar untuk semakan

## Lesen

Projek ini dilesenkan di bawah Lesen MIT - lihat fail [LICENSE](LICENSE) untuk butiran.

## Penghargaan

- Pembangun Bitcoin Core untuk protokol perlombongan
- Komuniti Go untuk perpustakaan yang cemerlang
- Semua penyumbang dan pengguna Otedama

## Sokongan

- Semak dokumentasi dalam direktori `docs/`
- Semak contoh konfigurasi dalam `config.example.yaml`
- Rujuk dokumentasi API di `/api/docs` semasa berjalan

## Derma

Jika anda mendapati Otedama berguna, pertimbangkan untuk menyokong pembangunan:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Sokongan anda membantu mengekalkan dan menambah baik Otedama!

---

**⚠️ Penting**: Perlombongan mata wang kripto menggunakan sumber pengiraan dan elektrik yang besar. Sila fahami kos dan kesan alam sekitar sebelum memulakan perlombongan.