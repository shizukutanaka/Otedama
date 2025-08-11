# Otedama - Hướng dẫn Sử dụng Phần mềm Pool Khai thác P2P

## Mục lục
1. [Cài đặt](#cài-đặt)
2. [Cấu hình](#cấu-hình)
3. [Chạy Otedama](#chạy-otedama)
4. [Hoạt động Khai thác](#hoạt-động-khai-thác)
5. [Quản lý Pool](#quản-lý-pool)
6. [Giám sát](#giám-sát)
7. [Khắc phục Sự cố](#khắc-phục-sự-cố)

## Cài đặt

### Yêu cầu Hệ thống
- Hệ điều hành: Linux, Windows, macOS
- RAM: Tối thiểu 4GB, Khuyến nghị 8GB+
- Lưu trữ: 50GB+ dung lượng trống
- Mạng: Kết nối internet ổn định

### Cài đặt Nhanh
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Cấu hình
Tạo `config.yaml` với thuật toán, luồng, URL pool, địa chỉ ví.

## Chạy Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ĐỊA_CHỈ --worker worker1
```

## Hỗ trợ
- GitHub: https://github.com/otedama/otedama
