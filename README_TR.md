# Otedama - Kurumsal P2P Madencilik Havuzu ve Madencilik Yazılımı

**Sürüm**: 2.1.5  
**Lisans**: MIT  
**Go Sürümü**: 1.21+  
**Mimari**: P2P havuz desteği ile mikroservisler  
**Yayınlanma tarihi**: 6 Ağustos 2025

Otedama, maksimum verimlilik ve güvenilirlik için tasarlanmış kurumsal sınıf P2P madencilik havuzu ve madencilik yazılımıdır. John Carmack (performans), Robert C. Martin (temiz mimari) ve Rob Pike (basitlik) tasarım ilkelerine göre inşa edilmiş olup, ulusal ölçeklenebilirlik ile kapsamlı CPU/GPU/ASIC madenciliği destekler.

## Mimari

### P2P Madencilik Havuzu
- **Dağıtık Havuz Yönetimi**: Otomatik yük devretme ile dağıtık madencilik havuzu
- **Ödül Dağıtımı**: Çoklu para birimi desteği ile gelişmiş PPS/PPLNS algoritmaları
- **Federasyon Protokolü**: Artan dayanıklılık için havuzlar arası iletişim
- **Ulusal Seviye İzleme**: Devlet dağıtımları için uygun kurumsal izleme

### Madencilik Özellikleri
- **Çoklu Algoritma**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Evrensel Donanım**: CPU, GPU (CUDA/OpenCL), ASIC için optimize edilmiş
- **Gelişmiş Stratum**: Yüksek performanslı madenciler için uzantılarla tam v1/v2 desteği
- **Sıfır Kopyalama Optimizasyonları**: Önbellek bilincinde veri yapıları ve NUMA bilincinde bellek

### Kurumsal Özellikler
- **Üretime Hazır**: Otomatik ölçeklendirme ile Docker/Kubernetes dağıtımı
- **Kurumsal Güvenlik**: DDoS koruması, hız sınırlama, kapsamlı denetim
- **Yüksek Kullanılabilirlik**: Otomatik yük devretme ile çoklu düğüm kurulumu
- **Gerçek Zamanlı Analitik**: Canlı gösterge paneli entegrasyonu ile WebSocket API

## Gereksinimler

- Go 1.21 veya üzeri
- Linux, macOS, Windows
- Madencilik donanımı (CPU/GPU/ASIC)
- Madencilik havuzuna ağ bağlantısı

## Kurulum

### Kaynak koddan

```bash
# Kaynak kod dizininde derle
cd Otedama

# İkili dosya derle
make build

# Sisteme kur
make install
```

### Go Build Kullanma

```bash
go build ./cmd/otedama
```

### Docker Üretim

```bash
# Üretim dağıtımı
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Tam yığın dağıt
kubectl apply -f k8s/
```

## Hızlı Başlangıç

### 1. Yapılandırma

```yaml
# P2P havuz desteği ile üretim yapılandırması
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Otomatik algılama
    priority: "normal"
  
  gpu:
    devices: [] # Tüm cihazları otomatik algıla
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Otomatik keşif
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

### 2. Dağıtım Seçenekleri

```bash
# Geliştirme
./otedama serve --config config.yaml

# Üretim Docker
docker-compose -f docker-compose.production.yml up -d

# Kurumsal Kubernetes
kubectl apply -f k8s/

# Manuel üretim dağıtımı
sudo ./scripts/production-deploy.sh
```

### 3. Performans İzleme

```bash
# Durumu kontrol et
./otedama status

# Günlükleri görüntüle
tail -f logs/otedama.log

# API uç noktası
curl http://localhost:8080/api/status
```

## Performans

Otedama maksimum verimlilik için optimize edilmiştir:

- **Bellek Kullanımı**: Minimum bellek ayak izi için optimize edilmiş
- **İkili Boyut**: Kompakt boyut (~15MB)
- **Başlangıç Zamanı**: <500ms
- **CPU Yükü**: İzleme için <%1

## API Referansı

### REST Uç Noktaları

- `GET /api/status` - Madencilik durumu
- `GET /api/stats` - Detaylı istatistikler
- `GET /api/workers` - Çalışan bilgisi
- `POST /api/mining/start` - Madenciliği başlat
- `POST /api/mining/stop` - Madenciliği durdur

### WebSocket

Gerçek zamanlı güncellemeler için `ws://localhost:8080/api/ws`'ye bağlanın.

## Dağıtım

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

## Katkı

Katkılar memnuniyetle karşılanır! Standart geliştirme uygulamalarını takip edin:

1. Özellik dalı oluştur
2. Değişiklikleri yap
3. Kapsamlı test et
4. İnceleme için gönder

## Lisans

Bu proje MIT Lisansı altında lisanslanmıştır - ayrıntılar için [LICENSE](LICENSE) dosyasına bakın.

## Teşekkürler

- Madencilik protokolleri için Bitcoin Core geliştiricileri
- Mükemmel kütüphaneler için Go topluluğu
- Tüm Otedama katkıda bulunanları ve kullanıcıları

## Destek

- `docs/` dizinindeki belgeleri kontrol edin
- `config.example.yaml`'daki yapılandırma örneklerini inceleyin
- Çalışma sırasında `/api/docs`'taki API belgelerine başvurun

## Bağışlar

Otedama'yı faydalı buluyorsanız, geliştirme desteği düşünün:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Desteğiniz Otedama'nın bakımı ve geliştirilmesine yardımcı oluyor!

---

**⚠️ Önemli**: Kripto para madenciliği önemli hesaplama kaynakları ve elektrik tüketir. Madenciliğe başlamadan önce maliyetleri ve çevresel etkiyi anlayın.