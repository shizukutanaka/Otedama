# Otedama - P2P挖矿池软件使用指南

## 目录
1. [安装](#安装)
2. [配置](#配置)
3. [运行Otedama](#运行otedama)
4. [挖矿操作](#挖矿操作)
5. [矿池管理](#矿池管理)
6. [监控](#监控)
7. [故障排除](#故障排除)

## 安装

### 系统要求
- 操作系统：Linux、Windows、macOS
- 内存：最低4GB，推荐8GB以上
- 存储：50GB以上可用空间
- 网络：稳定的互联网连接

### 快速安装
```bash
# 下载最新版本
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# 或从源代码构建
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## 配置

### 基本配置
创建`config.yaml`：
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: 您的钱包地址
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

### 高级设置
```yaml
hardware:
  cpu:
    enabled: true
    threads: 8
  gpu:
    enabled: true
    devices: [0, 1]
  asic:
    enabled: false

monitoring:
  enabled: true
  listen_addr: 0.0.0.0:8080
  prometheus_enabled: true
```

## 运行Otedama

### 单独挖矿
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### 矿池挖矿
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet 钱包地址 --worker worker1
```

### P2P矿池模式
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

### Docker部署
```bash
docker run -d \
  --name otedama \
  -p 19333:19333 \
  -p 8080:8080 \
  -v ./config.yaml:/config.yaml \
  otedama/otedama:latest
```

## 挖矿操作

### 支持的算法
- SHA256d（比特币）
- Scrypt（莱特币）
- Ethash（以太坊经典）
- KawPow（渡鸦币）
- RandomX（门罗币）
- Autolykos2（尔格）

### 硬件优化
```bash
# 使用SIMD优化的CPU挖矿
./otedama --cpu --optimize simd

# 多设备GPU挖矿
./otedama --gpu --devices 0,1,2,3

# ASIC挖矿
./otedama --asic --model antminer-s19
```

### 性能调优
```bash
# 调整强度（1-20）
./otedama --intensity 15

# 内存优化
./otedama --memory-pool 2048

# 网络优化
./otedama --low-latency --max-connections 100
```

## 矿池管理

### 启动矿池服务器
```bash
./otedama pool --listen 0.0.0.0:3333 --fee 1.0 --min-payout 0.001
```

### 矿工管理
```bash
# 列出矿工
./otedama workers list

# 添加矿工
./otedama workers add --name worker1 --wallet 地址

# 删除矿工
./otedama workers remove worker1

# 查看矿工统计
./otedama workers stats worker1
```

### 支付配置
```yaml
pool:
  payout_scheme: PPLNS  # 或 PPS、PROP
  payout_interval: 24h
  min_payout: 0.001
  fee_percent: 1.0
```

## 监控

### Web仪表板
访问`http://localhost:8080`

功能：
- 实时算力图表
- 矿工统计
- 矿池性能指标
- 支付历史

### 命令行监控
```bash
# 查看当前统计
./otedama stats

# 实时监控
./otedama monitor

# 导出指标
./otedama metrics export --format json
```

### Prometheus集成
```yaml
monitoring:
  prometheus_enabled: true
  prometheus_port: 9090
```

### 警报配置
```yaml
alerts:
  email:
    enabled: true
    smtp_server: smtp.gmail.com:587
    from: alerts@example.com
    to: admin@example.com
  thresholds:
    min_hashrate: 1000000
    max_temperature: 85
    min_workers: 5
```

## 故障排除

### 常见问题

#### 连接问题
```bash
# 测试矿池连接
./otedama test --pool stratum+tcp://pool.example.com:3333

# 调试网络
./otedama --debug --verbose
```

#### 性能问题
```bash
# 运行基准测试
./otedama benchmark --duration 60

# CPU使用分析
./otedama --profile cpu.prof
```

#### 硬件检测
```bash
# 扫描硬件
./otedama hardware scan

# 测试特定设备
./otedama hardware test --gpu 0
```

### 日志文件
```bash
# 查看日志
tail -f /var/log/otedama/otedama.log

# 更改日志级别
./otedama --log-level debug
```

### 恢复模式
```bash
# 安全模式启动
./otedama --safe-mode

# 重置配置
./otedama --reset-config

# 数据库修复
./otedama db repair
```

## API参考

### REST API
```bash
# 获取状态
curl http://localhost:8080/api/status

# 获取矿工
curl http://localhost:8080/api/workers

# 提交份额
curl -X POST http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d '{"worker":"worker1","nonce":"12345678"}'
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('message', (data) => {
  console.log('接收到:', data);
});
```

## 安全

### 认证
```yaml
security:
  auth_enabled: true
  jwt_secret: 您的密钥
  api_keys:
    - key: API_KEY_1
      permissions: [read, write]
```

### SSL/TLS
```yaml
security:
  tls_enabled: true
  cert_file: /path/to/cert.pem
  key_file: /path/to/key.pem
```

### 防火墙规则
```bash
# 允许Stratum
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# 允许P2P
iptables -A INPUT -p tcp --dport 19333 -j ACCEPT

# 允许监控
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## 支持

- GitHub：https://github.com/otedama/otedama
