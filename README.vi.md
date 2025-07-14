# Otedama v0.5

**Nền tảng P2P Mining Pool + DEX + DeFi Hoàn toàn Tự động**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md) | [Tiếng Việt](README.vi.md)

---

## Tổng quan

Otedama là nền tảng pool khai thác P2P, DEX và DeFi cấp thương mại hoàn toàn tự động. Được xây dựng theo triết lý thiết kế của John Carmack (hiệu suất trước tiên), Robert C. Martin (kiến trúc sạch) và Rob Pike (đơn giản).

### Tính năng chính

- **Vận hành Hoàn toàn Tự động** - Không cần can thiệp thủ công
- **Hệ thống Phí Bất biến** - Thu phí BTC tự động 1,5% không thể sửa đổi
- **Hỗ trợ Đa thuật toán** - Tương thích CPU/GPU/ASIC
- **DEX Thống nhất** - V2 AMM + V3 Thanh khoản Tập trung
- **Thanh toán Tự động** - Thanh toán phần thưởng cho thợ đào tự động mỗi giờ
- **Tính năng DeFi** - Tự động thanh lý, quản trị, cầu nối
- **Cấp Doanh nghiệp** - Hỗ trợ 10.000+ thợ đào

### Tính năng Tự động hóa Vận hành

1. **Thu phí Tự động**
   - Địa chỉ BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (bất biến)
   - Phí Pool: 0% (đã loại bỏ)
   - Phí Vận hành: 1,5% (không thể sửa đổi)
   - Tổng Phí: 1,5% (chỉ phí vận hành)
   - Tần suất Thu: Mỗi 5 phút
   - Tự động chuyển đổi tất cả tiền tệ sang BTC

2. **Phân phối Phần thưởng Khai thác Tự động**
   - Thực hiện mỗi giờ
   - Tự động khấu trừ phí pool
   - Tự động gửi khi đạt thanh toán tối thiểu
   - Tự động ghi lại giao dịch

3. **DEX/DeFi Hoàn toàn Tự động**
   - Tự động cân bằng lại pool thanh khoản
   - Tự động thanh lý (85% LTV)
   - Tự động thực hiện đề xuất quản trị
   - Tự động chuyển tiếp cầu nối cross-chain

---

## Yêu cầu Hệ thống

### Yêu cầu Tối thiểu
- Node.js 18+
- RAM: 2GB
- Lưu trữ: 10GB SSD
- Mạng: 100Mbps

### Yêu cầu Khuyến nghị
- CPU: 8+ lõi
- RAM: 8GB+
- Lưu trữ: 100GB NVMe SSD
- Mạng: 1Gbps

---

## Cài đặt

### 1. Cài đặt Cơ bản

```bash
# Clone repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Cài đặt dependencies
npm install

# Khởi động
npm start
```

### 2. Cài đặt Docker

```bash
# Khởi động với Docker Compose
docker-compose up -d

# Kiểm tra logs
docker-compose logs -f otedama
```

### 3. Cài đặt Một Click

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

## Cấu hình

### Cấu hình Cơ bản

Chỉnh sửa `otedama.json`:

```json
{
  "pool": {
    "name": "Tên Pool của Bạn",
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
    "walletAddress": "Địa chỉ Ví của Bạn"
  }
}
```

### Cấu hình Dòng lệnh

```bash
# Khởi động cơ bản
node index.js --wallet RYourWalletAddress --currency RVN

# Hiệu suất cao
node index.js --threads 16 --max-miners 5000 --enable-dex

# Cổng tùy chỉnh
node index.js --api-port 9080 --stratum-port 4444
```

---

## Kết nối Thợ đào

### Thông tin Kết nối
- Máy chủ: `IP_CỦA_BẠN:3333`
- Tên người dùng: `ĐịaChỉVí.TênWorker`
- Mật khẩu: `x`

### Ví dụ Phần mềm Khai thác

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://IP_CỦA_BẠN:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://IP_CỦA_BẠN:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o IP_CỦA_BẠN:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Tiền tệ Được hỗ trợ

| Tiền tệ | Thuật toán | Thanh toán Tối thiểu | Phí |
|---------|------------|---------------------|-----|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Tất cả tiền tệ: phí cố định 1,5% (chỉ phí vận hành) - không thể sửa đổi

---

## API

### REST Endpoints

```bash
# Thống kê pool
GET /api/stats

# Trạng thái thu phí
GET /api/fees

# Thông tin thợ đào
GET /api/miners/{minerId}

# Giá DEX
GET /api/dex/prices

# Sức khỏe hệ thống
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

## Thông tin cho Nhà điều hành

### Cơ cấu Doanh thu

1. **Phí Vận hành**: 1,5% cố định (không thể sửa đổi)
2. **Phí DEX**: 0,3% (phân phối cho nhà cung cấp thanh khoản)
3. **Phí DeFi**: Một phần lãi suất cho vay

### Tác vụ Tự động

- **Mỗi 5 phút**: Chuyển đổi và thu phí vận hành BTC
- **Mỗi 10 phút**: Cân bằng lại pool DEX
- **Mỗi 30 phút**: Kiểm tra thanh lý DeFi
- **Mỗi giờ**: Thanh toán tự động cho thợ đào
- **Mỗi 24 giờ**: Tối ưu hóa cơ sở dữ liệu và sao lưu

### Giám sát

Bảng điều khiển: `http://localhost:8080`

Số liệu Chính:
- Thợ đào hoạt động
- Hashrate
- Doanh thu phí
- Khối lượng DEX
- Tài nguyên hệ thống

---

## Bảo mật

### Bảo vệ Đã triển khai

1. **Bảo vệ DDoS**
   - Giới hạn tốc độ đa lớp
   - Ngưỡng thích ứng
   - Thách thức-phản hồi

2. **Hệ thống Xác thực**
   - JWT + MFA
   - Kiểm soát truy cập dựa trên vai trò
   - Quản lý khóa API

3. **Ngăn chặn Can thiệp**
   - Địa chỉ phí vận hành bất biến
   - Kiểm tra tính toàn vẹn hệ thống
   - Nhật ký kiểm toán

---

## Khắc phục sự cố

### Cổng Đang sử dụng
```bash
# Kiểm tra tiến trình sử dụng cổng
netstat -tulpn | grep :8080

# Dừng tiến trình
kill -9 PID
```

### Vấn đề Bộ nhớ
```bash
# Tăng giới hạn bộ nhớ Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Chế độ Debug
```bash
DEBUG=* node index.js
```

---

## Tối ưu hóa Hiệu suất

### Tính năng Tối ưu hóa

- **Xử lý hàng loạt Cơ sở dữ liệu**: Nhanh hơn 70%
- **Tối ưu hóa Mạng**: Giảm 40% băng thông
- **Bộ nhớ đệm Nâng cao**: Tỷ lệ trúng 85%+
- **Hoạt động Zero-Copy**: Xử lý khai thác hiệu quả

### Kết quả Benchmark

```bash
# Chạy benchmark
npm run benchmark

# Kết quả (8 lõi, 16GB RAM):
- Cơ sở dữ liệu: 50.000+ ops/giây
- Mạng: 10.000+ msg/giây
- Tỷ lệ trúng cache: 85%+
- Sử dụng bộ nhớ: <100MB (cơ bản)
```

---

## Giấy phép

Giấy phép MIT - Cho phép sử dụng thương mại

## Hỗ trợ

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Tương lai của Khai thác Tự động

---