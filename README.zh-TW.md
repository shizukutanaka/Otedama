# Otedama v0.5

**全自動P2P礦池 + DEX + DeFi平台**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## 概述

Otedama是一個完全自動化的商業級P2P礦池、DEX和DeFi平台。遵循John Carmack（性能優先）、Robert C. Martin（清潔架構）和Rob Pike（簡約）的設計理念構建。

### 主要特性

- **全自動運營** - 無需人工干預
- **不可變手續費系統** - 不可修改的1.5% BTC自動收取
- **多算法支持** - CPU/GPU/ASIC兼容
- **統一DEX** - V2 AMM + V3集中流動性
- **自動支付** - 每小時自動礦工獎勵支付
- **DeFi功能** - 自動清算、治理、跨鏈橋
- **企業級** - 支持10,000+礦工

### 運營自動化特性

1. **自動手續費收取**
   - BTC地址：1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa（不可變）
   - 礦池手續費：0%（已刪除）
   - 運營手續費：1.5%（不可修改）
   - 總手續費：1.5%（僅運營手續費）
   - 收取頻率：每5分鐘
   - 自動將所有貨幣轉換為BTC

2. **自動挖礦獎勵分配**
   - 每小時執行
   - 自動扣除礦池費用
   - 達到最低支付額時自動發送
   - 自動記錄交易

3. **完全自動化的DEX/DeFi**
   - 自動重新平衡流動性池
   - 自動清算（85% LTV）
   - 自動執行治理提案
   - 自動中繼跨鏈橋

---

## 系統要求

### 最低要求
- Node.js 18+
- 內存：2GB
- 存儲：10GB SSD
- 網絡：100Mbps

### 推薦要求
- CPU：8+核心
- 內存：8GB+
- 存儲：100GB NVMe SSD
- 網絡：1Gbps

---

## 安裝

### 1. 基本安裝

```bash
# 克隆倉庫
git clone https://github.com/otedama/otedama.git
cd otedama

# 安裝依賴
npm install

# 啟動
npm start
```

### 2. Docker安裝

```bash
# 使用Docker Compose啟動
docker-compose up -d

# 查看日誌
docker-compose logs -f otedama
```

### 3. 一鍵安裝

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

## 配置

### 基本配置

編輯 `otedama.json`:

```json
{
  "pool": {
    "name": "您的礦池名稱",
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
    "walletAddress": "您的錢包地址"
  }
}
```

### 命令行配置

```bash
# 基本啟動
node index.js --wallet RYourWalletAddress --currency RVN

# 高性能
node index.js --threads 16 --max-miners 5000 --enable-dex

# 自定義端口
node index.js --api-port 9080 --stratum-port 4444
```

---

## 礦工連接

### 連接信息
- 服務器：`YOUR_IP:3333`
- 用戶名：`錢包地址.礦工名稱`
- 密碼：`x`

### 礦工軟件示例

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o YOUR_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## 支持的幣種

| 幣種 | 算法 | 最低支付 | 手續費 |
|------|------|----------|---------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

所有幣種：1.5%固定費率（僅運營手續費）- 不可修改

---

## API

### REST端點

```bash
# 礦池統計
GET /api/stats

# 手續費收取狀態
GET /api/fees

# 礦工信息
GET /api/miners/{minerId}

# DEX價格
GET /api/dex/prices

# 系統健康
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

## 運營商信息

### 收入結構

1. **運營手續費**：1.5%固定（不可修改）
2. **DEX手續費**：0.3%（分配給流動性提供者）
3. **DeFi手續費**：借貸利息的一部分

### 自動化任務

- **每5分鐘**：運營手續費BTC轉換和收取
- **每10分鐘**：DEX池重新平衡
- **每30分鐘**：DeFi清算檢查
- **每小時**：自動礦工支付
- **每24小時**：數據庫優化和備份

### 監控

儀表板：`http://localhost:8080`

關鍵指標：
- 活躍礦工
- 算力
- 手續費收入
- DEX交易量
- 系統資源

---

## 安全性

### 已實施的保護

1. **DDoS防護**
   - 多層速率限制
   - 自適應閾值
   - 挑戰-響應

2. **認證系統**
   - JWT + MFA
   - 基於角色的訪問控制
   - API密鑰管理

3. **防篡改**
   - 不可變的運營手續費地址
   - 系統完整性檢查
   - 審計日誌

---

## 故障排除

### 端口被佔用
```bash
# 檢查使用端口的進程
netstat -tulpn | grep :8080

# 停止進程
kill -9 PID
```

### 內存問題
```bash
# 增加Node.js內存限制
export NODE_OPTIONS="--max-old-space-size=8192"
```

### 調試模式
```bash
DEBUG=* node index.js
```

---

## 性能優化

### 優化功能

- **數據庫批處理**：提速70%
- **網絡優化**：減少40%帶寬
- **高級緩存**：85%+命中率
- **零拷貝操作**：高效挖礦處理

### 基準測試結果

```bash
# 運行基準測試
npm run benchmark

# 結果（8核，16GB RAM）：
- 數據庫：50,000+ ops/秒
- 網絡：10,000+ msg/秒
- 緩存命中率：85%+
- 內存使用：<100MB（基礎）
```

---

## 許可證

MIT許可證 - 允許商業使用

## 支持

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - 自動化挖礦的未來

---