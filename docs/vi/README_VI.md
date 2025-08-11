# Otedama - Pool Đào Coin P2P và Phần Mềm Đào Coin Doanh Nghiệp

**Phiên bản**: 2.1.6  
**Giấy phép**: MIT  
**Phiên bản Go**: 1.21+  
**Kiến trúc**: Microservices với hỗ trợ pool P2P  
**Ngày phát hành**: 6 tháng 8, 2025

Otedama là pool đào coin P2P và phần mềm đào coin cấp doanh nghiệp được thiết kế để đạt hiệu quả và độ tin cậy tối đa. Xây dựng theo các nguyên tắc thiết kế của John Carmack (hiệu suất), Robert C. Martin (kiến trúc sạch) và Rob Pike (đơn giản), hỗ trợ đào coin toàn diện CPU/GPU/ASIC với khả năng mở rộng cấp quốc gia.

## Kiến Trúc

### Pool Đào Coin P2P
- **Quản lý Pool Phân tán**: Pool đào coin phân tán với failover tự động
- **Phân phối Phần thưởng**: Thuật toán PPS/PPLNS tiên tiến với hỗ trợ đa tiền tệ
- **Giao thức Liên bang**: Giao tiếp giữa các pool để tăng khả năng phục hồi
- **Giám sát Cấp Quốc gia**: Giám sát doanh nghiệp phù hợp cho triển khai chính phủ

### Tính năng Đào Coin
- **Đa Thuật toán**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Phần cứng Đa năng**: Tối ưu hóa cho CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Tiên tiến**: Hỗ trợ đầy đủ v1/v2 với các mở rộng cho máy đào hiệu suất cao
- **Tối ưu hóa Zero-Copy**: Cấu trúc dữ liệu nhận thức cache và bộ nhớ nhận thức NUMA

### Tính năng Doanh nghiệp
- **Sẵn sàng Sản xuất**: Triển khai Docker/Kubernetes với auto-scaling
- **Bảo mật Doanh nghiệp**: Bảo vệ DDoS, giới hạn tốc độ, kiểm toán toàn diện
- **Tính khả dụng Cao**: Thiết lập đa node với failover tự động
- **Phân tích Thời gian Thực**: API WebSocket với tích hợp dashboard trực tiếp

## Yêu Cầu

- Go 1.21 hoặc cao hơn
- Linux, macOS, Windows
- Phần cứng đào coin (CPU/GPU/ASIC)
- Kết nối mạng đến pool đào coin

## Cài Đặt

### Từ mã nguồn

```bash
# Xây dựng trong thư mục mã nguồn
cd Otedama

# Xây dựng file nhị phân
make build

# Cài đặt vào hệ thống
make install
```

### Sử dụng Go Build

```bash
go build ./cmd/otedama
```

### Docker Sản xuất

```bash
# Triển khai sản xuất
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Triển khai stack đầy đủ
kubectl apply -f k8s/
```

## Khởi Động Nhanh

### 1. Cấu hình

```yaml
# Cấu hình sản xuất với hỗ trợ pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Tự động phát hiện
    priority: "normal"
  
  gpu:
    devices: [] # Tự động phát hiện tất cả thiết bị
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Tự động khám phá
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

### 2. Tùy chọn Triển khai

```bash
# Phát triển
./otedama serve --config config.yaml

# Docker Sản xuất
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Doanh nghiệp
kubectl apply -f k8s/

# Triển khai sản xuất thủ công
sudo ./scripts/production-deploy.sh
```

### 3. Giám sát Hiệu suất

```bash
# Kiểm tra trạng thái
./otedama status

# Xem log
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Hiệu Suất

Otedama được tối ưu hóa để đạt hiệu quả tối đa:

- **Sử dụng Bộ nhớ**: Tối ưu hóa cho dấu chân bộ nhớ tối thiểu
- **Kích thước Binary**: Kích thước nhỏ gọn (~15MB)
- **Thời gian Khởi động**: <500ms
- **CPU Overhead**: <1% cho giám sát

## Tham Chiếu API

### REST Endpoints

- `GET /api/status` - Trạng thái đào coin
- `GET /api/stats` - Thống kê chi tiết
- `GET /api/workers` - Thông tin worker
- `POST /api/mining/start` - Bắt đầu đào coin
- `POST /api/mining/stop` - Dừng đào coin

### WebSocket

Kết nối đến `ws://localhost:8080/api/ws` để cập nhật thời gian thực.

## Triển Khai

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

## Đóng Góp

Các đóng góp được hoan nghênh! Vui lòng tuân theo các thực hành phát triển tiêu chuẩn:

1. Tạo nhánh tính năng
2. Thực hiện thay đổi
3. Kiểm tra kỹ lưỡng
4. Gửi để đánh giá

## Giấy Phép

Dự án này được cấp phép theo Giấy phép MIT - xem file [LICENSE](LICENSE) để biết chi tiết.

## Lời Cảm Ơn

- Các nhà phát triển Bitcoin Core cho giao thức đào coin
- Cộng đồng Go cho các thư viện tuyệt vời
- Tất cả các cộng tác viên và người dùng Otedama

## Hỗ Trợ

- Kiểm tra tài liệu trong thư mục `docs/`
- Xem các ví dụ cấu hình trong `config.example.yaml`
- Tham khảo tài liệu API tại `/api/docs` khi chạy

## Quyên Góp

Nếu bạn thấy Otedama hữu ích, hãy xem xét hỗ trợ phát triển:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Sự hỗ trợ của bạn giúp duy trì và cải thiện Otedama!

---

**⚠️ Quan trọng**: Đào coin tiền điện tử tiêu thụ tài nguyên tính toán và điện năng đáng kể. Vui lòng hiểu rõ chi phí và tác động môi trường trước khi bắt đầu đào coin.