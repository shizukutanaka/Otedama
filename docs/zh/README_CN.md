# Otedama - 企业级P2P挖矿池和挖矿软件

**版本**: 2.1.6  
**许可证**: MIT  
**Go版本**: 1.21+  
**架构**: 支持P2P池的微服务  
**发布日期**: 2025年8月6日

Otedama是一个为追求最高效率和可靠性而设计的企业级P2P挖矿池和挖矿软件。遵循John Carmack（性能）、Robert C. Martin（清洁架构）和Rob Pike（简洁性）的设计原则，支持具有国家级可扩展性的全面CPU/GPU/ASIC挖矿。

## 架构

### P2P挖矿池
- **分布式池管理**: 带自动故障转移的分布式挖矿池
- **奖励分配**: 支持多币种的高级PPS/PPLNS算法
- **联邦协议**: 池间通信以增强弹性
- **国家级监控**: 适合政府部署的企业监控

### 挖矿功能
- **多算法**: SHA256d、Ethash、RandomX、Scrypt、KawPow
- **通用硬件**: 针对CPU、GPU（CUDA/OpenCL）、ASIC优化
- **高级Stratum**: 完全v1/v2支持，带高性能矿机扩展
- **零拷贝优化**: 缓存感知数据结构和NUMA感知内存

### 企业功能
- **生产就绪**: 支持自动缩放的Docker/Kubernetes部署
- **企业安全**: DDoS保护、速率限制、全面审计
- **高可用性**: 自动故障转移的多节点设置
- **实时分析**: 支持实时仪表板集成的WebSocket API

## 要求

- Go 1.21或更高版本
- Linux、macOS、Windows
- 挖矿硬件（CPU/GPU/ASIC）
- 到挖矿池的网络连接

## 安装

### 从源码安装

```bash
# 在源码目录中构建
cd Otedama

# 构建二进制文件
make build

# 安装到系统
make install
```

### 使用Go Build

```bash
go build ./cmd/otedama
```

### Docker生产环境

```bash
# 生产部署
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# 部署完整堆栈
kubectl apply -f k8s/
```

## 快速开始

### 1. 配置

```yaml
# 支持P2P池的生产配置
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # 自动检测
    priority: "normal"
  
  gpu:
    devices: [] # 自动检测所有设备
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # 自动发现
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

### 2. 部署选项

```bash
# 开发环境
./otedama serve --config config.yaml

# 生产Docker
docker-compose -f docker-compose.production.yml up -d

# 企业Kubernetes
kubectl apply -f k8s/

# 手动生产部署
sudo ./scripts/production-deploy.sh
```

### 3. 性能监控

```bash
# 检查状态
./otedama status

# 查看日志
tail -f logs/otedama.log

# API端点
curl http://localhost:8080/api/status
```

## 性能

Otedama已针对最大效率进行优化：

- **内存使用**: 优化为最小内存占用
- **二进制大小**: 紧凑大小（约15MB）
- **启动时间**: <500ms
- **CPU开销**: 监控<1%

## API参考

### REST端点

- `GET /api/status` - 挖矿状态
- `GET /api/stats` - 详细统计
- `GET /api/workers` - 工作者信息
- `POST /api/mining/start` - 开始挖矿
- `POST /api/mining/stop` - 停止挖矿

### WebSocket

连接到`ws://localhost:8080/api/ws`获取实时更新。

## 部署

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

## 贡献

欢迎贡献！请遵循标准开发实践：

1. 创建功能分支
2. 进行更改
3. 彻底测试
4. 提交审查

## 许可证

此项目根据MIT许可证获得许可 - 详情请见[LICENSE](LICENSE)文件。

## 致谢

- 挖矿协议的Bitcoin Core开发者
- 优秀库的Go社区
- Otedama的所有贡献者和用户

## 支持

- 查看`docs/`目录中的文档
- 查看`config.example.yaml`中的配置示例
- 运行时在`/api/docs`查看API文档

## 捐赠

如果您觉得Otedama有用，请考虑支持开发：

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

您的支持有助于维护和改进Otedama！

---

**⚠️ 重要**: 加密货币挖矿消耗大量计算资源和电力。开始挖矿前请了解成本和环境影响。