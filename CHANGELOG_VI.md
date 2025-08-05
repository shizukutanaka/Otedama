# Nhật ký thay đổi

Tất cả các thay đổi đáng chú ý của Otedama sẽ được ghi lại trong tệp này.

Định dạng dựa trên [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
và dự án này tuân thủ [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.5] - 2025-08-05

### Đã thêm
- Hỗ trợ đa ngôn ngữ toàn diện với tệp README bằng 30 ngôn ngữ
- Tệp CHANGELOG đa ngôn ngữ cho tất cả các ngôn ngữ được hỗ trợ
- Cơ sở hạ tầng quốc tế hóa hoàn chỉnh

### Đã thay đổi
- Cấu trúc tài liệu để hỗ trợ triển khai toàn cầu
- Cải thiện tổ chức của các tệp dành riêng cho ngôn ngữ

### Đã sửa
- Tất cả các lỗi biên dịch còn lại
- Vấn đề chu kỳ nhập đã được giải quyết hoàn toàn

## [2.1.4] - 2024-01-20

### Đã thêm
- Chức năng pool khai thác P2P cấp doanh nghiệp
- Hỗ trợ đa tiền tệ với thuật toán phần thưởng PPS/PPLNS
- Giao thức liên bang để giao tiếp giữa các pool
- Khả năng giám sát cấp quốc gia
- Giao thức Stratum v1/v2 nâng cao với tiện ích mở rộng hiệu suất cao
- Tối ưu hóa zero-copy để cải thiện hiệu suất
- Phân bổ bộ nhớ nhận biết NUMA
- Giám sát phần cứng toàn diện (CPU/GPU/ASIC)
- API WebSocket thời gian thực cho cập nhật trực tiếp
- Tính năng bảo mật doanh nghiệp (bảo vệ DDoS, giới hạn tốc độ)
- Triển khai Docker/Kubernetes với tự động mở rộng
- Hỗ trợ đa ngôn ngữ (30 ngôn ngữ)

### Đã thay đổi
- Nâng cấp kiến trúc lên microservices với hỗ trợ pool P2P
- Cải tiến engine khai thác với cấu trúc dữ liệu nhận biết cache
- Cải thiện hệ thống cấu hình với xác thực
- Cập nhật API với các điểm cuối giám sát toàn diện
- Hiện đại hóa hướng dẫn triển khai cho sử dụng doanh nghiệp

### Đã sửa
- Vấn đề rò rỉ bộ nhớ trong công nhân khai thác
- Lỗi biên dịch trong gói crypto và bộ nhớ
- Phụ thuộc chu kỳ nhập
- Hợp nhất tệp trùng lặp trong toàn bộ codebase

### Bảo mật
- Đã thêm bảo vệ DDoS toàn diện
- Triển khai xác thực cấp doanh nghiệp
- Cải thiện xác thực và làm sạch đầu vào
- Đã thêm ghi nhật ký kiểm toán bảo mật