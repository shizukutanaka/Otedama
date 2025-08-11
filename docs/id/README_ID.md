# Otedama - Pool Mining P2P dan Software Mining Enterprise

**Versi**: 2.1.6  
**Lisensi**: MIT  
**Versi Go**: 1.21+  
**Arsitektur**: Microservices dengan dukungan pool P2P  
**Tanggal Rilis**: 6 Agustus 2025

Otedama adalah pool mining P2P dan software mining tingkat enterprise yang dirancang untuk efisiensi dan keandalan maksimum. Dibangun mengikuti prinsip desain John Carmack (performa), Robert C. Martin (arsitektur bersih) dan Rob Pike (kesederhanaan), mendukung mining CPU/GPU/ASIC komprehensif dengan skalabilitas tingkat nasional.

## Arsitektur

### Pool Mining P2P
- **Manajemen Pool Terdistribusi**: Pool mining terdistribusi dengan failover otomatis
- **Distribusi Reward**: Algoritma PPS/PPLNS canggih dengan dukungan multi-mata uang
- **Protokol Federasi**: Komunikasi antar-pool untuk ketahanan yang ditingkatkan
- **Monitoring Tingkat Nasional**: Monitoring enterprise yang cocok untuk deployment pemerintah

### Fitur Mining
- **Multi-Algoritma**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Hardware Universal**: Dioptimalkan untuk CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Canggih**: Dukungan lengkap v1/v2 dengan ekstensi untuk miner performa tinggi
- **Optimisasi Zero-Copy**: Struktur data cache-aware dan memori NUMA-aware

### Fitur Enterprise
- **Siap Produksi**: Deployment Docker/Kubernetes dengan auto-scaling
- **Keamanan Enterprise**: Perlindungan DDoS, rate limiting, auditing komprehensif
- **High Availability**: Setup multi-node dengan failover otomatis
- **Analytics Real-time**: WebSocket API dengan integrasi dashboard langsung

## Persyaratan

- Go 1.21 atau lebih tinggi
- Linux, macOS, Windows
- Hardware mining (CPU/GPU/ASIC)
- Koneksi jaringan ke pool mining

## Instalasi

### Dari source

```bash
# Build di direktori source
cd Otedama

# Build binary
make build

# Install ke sistem
make install
```

### Menggunakan Go Build

```bash
go build ./cmd/otedama
```

### Docker Produksi

```bash
# Deployment produksi
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Deploy stack lengkap
kubectl apply -f k8s/
```

## Quick Start

### 1. Konfigurasi

```yaml
# Konfigurasi produksi dengan dukungan pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detect
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detect semua device
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-discovery
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

### 2. Opsi Deployment

```bash
# Development
./otedama serve --config config.yaml

# Production Docker
docker-compose -f docker-compose.production.yml up -d

# Enterprise Kubernetes
kubectl apply -f k8s/

# Manual production deployment
sudo ./scripts/production-deploy.sh
```

### 3. Monitoring Performa

```bash
# Cek status
./otedama status

# Lihat log
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Performa

Otedama dioptimalkan untuk efisiensi maksimum:

- **Penggunaan Memori**: Dioptimalkan untuk footprint memori minimal
- **Ukuran Binary**: Ukuran kompak (~15MB)
- **Waktu Startup**: <500ms
- **CPU Overhead**: <1% untuk monitoring

## Referensi API

### REST Endpoints

- `GET /api/status` - Status mining
- `GET /api/stats` - Statistik detail
- `GET /api/workers` - Informasi worker
- `POST /api/mining/start` - Mulai mining
- `POST /api/mining/stop` - Stop mining

### WebSocket

Koneksi ke `ws://localhost:8080/api/ws` untuk update real-time.

## Deployment

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

## Kontribusi

Kontribusi diterima dengan baik! Harap ikuti praktik pengembangan standar:

1. Buat feature branch
2. Lakukan perubahan
3. Test secara menyeluruh
4. Submit untuk review

## Lisensi

Proyek ini dilisensikan di bawah MIT License - lihat file [LICENSE](LICENSE) untuk detail.

## Penghargaan

- Developer Bitcoin Core untuk protokol mining
- Komunitas Go untuk library yang luar biasa
- Semua kontributor dan pengguna Otedama

## Dukungan

- Periksa dokumentasi di direktori `docs/`
- Tinjau contoh konfigurasi di `config.example.yaml`
- Konsultasi dokumentasi API di `/api/docs` saat berjalan

## Donasi

Jika Anda merasa Otedama berguna, pertimbangkan untuk mendukung pengembangan:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Dukungan Anda membantu memelihara dan meningkatkan Otedama!

---

**⚠️ Penting**: Mining cryptocurrency mengonsumsi sumber daya komputasi dan listrik yang signifikan. Harap pahami biaya dan dampak lingkungan sebelum memulai mining.