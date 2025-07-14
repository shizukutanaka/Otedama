# Otedama v0.5

**완전 자동화 P2P 마이닝 풀 + DEX + DeFi 플랫폼**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## 개요

Otedama는 완전 자동화된 상업용 P2P 마이닝 풀, DEX 및 DeFi 플랫폼입니다. John Carmack(성능 우선), Robert C. Martin(클린 아키텍처), Rob Pike(단순성)의 설계 철학을 따라 구축되었습니다.

### 주요 기능

- **완전 자동 운영** - 수동 개입 필요 없음
- **불변 수수료 시스템** - 수정 불가능한 1.5% BTC 자동 수집
- **멀티 알고리즘 지원** - CPU/GPU/ASIC 호환
- **통합 DEX** - V2 AMM + V3 집중 유동성
- **자동 지불** - 시간당 자동 채굴자 보상 지불
- **DeFi 기능** - 자동 청산, 거버넌스, 브리징
- **엔터프라이즈급** - 10,000+ 채굴자 지원

### 운영 자동화 기능

1. **자동 수수료 수집**
   - BTC 주소: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (불변)
   - 풀 수수료: 0% (삭제됨)
   - 운영 수수료: 1.5% (수정 불가)
   - 총 수수료: 1.5% (운영 수수료만)
   - 수집 빈도: 5분마다
   - 모든 통화를 BTC로 자동 변환

2. **자동 채굴 보상 분배**
   - 매시간 실행
   - 풀 수수료 자동 공제
   - 최소 지불액 도달 시 자동 전송
   - 거래 자동 기록

3. **완전 자동화 DEX/DeFi**
   - 유동성 풀 자동 리밸런싱
   - 자동 청산 (85% LTV)
   - 거버넌스 제안 자동 실행
   - 크로스체인 브리지 자동 중계

---

## 시스템 요구사항

### 최소 요구사항
- Node.js 18+
- RAM: 2GB
- 스토리지: 10GB SSD
- 네트워크: 100Mbps

### 권장 요구사항
- CPU: 8+ 코어
- RAM: 8GB+
- 스토리지: 100GB NVMe SSD
- 네트워크: 1Gbps

---

## 설치

### 1. 기본 설치

```bash
# 저장소 복제
git clone https://github.com/otedama/otedama.git
cd otedama

# 의존성 설치
npm install

# 시작
npm start
```

### 2. Docker 설치

```bash
# Docker Compose로 시작
docker-compose up -d

# 로그 확인
docker-compose logs -f otedama
```

### 3. 원클릭 설치

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

## 설정

### 기본 설정

`otedama.json` 편집:

```json
{
  "pool": {
    "name": "풀 이름",
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
    "walletAddress": "지갑 주소"
  }
}
```

### 명령줄 설정

```bash
# 기본 시작
node index.js --wallet RYourWalletAddress --currency RVN

# 고성능
node index.js --threads 16 --max-miners 5000 --enable-dex

# 사용자 정의 포트
node index.js --api-port 9080 --stratum-port 4444
```

---

## 채굴자 연결

### 연결 정보
- 서버: `YOUR_IP:3333`
- 사용자명: `지갑주소.워커명`
- 비밀번호: `x`

### 채굴 소프트웨어 예시

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

## 지원 통화

| 통화 | 알고리즘 | 최소 지불 | 수수료 |
|------|----------|-----------|---------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

모든 통화: 1.5% 고정 수수료 (운영 수수료만) - 수정 불가

---

## API

### REST 엔드포인트

```bash
# 풀 통계
GET /api/stats

# 수수료 수집 상태
GET /api/fees

# 채굴자 정보
GET /api/miners/{minerId}

# DEX 가격
GET /api/dex/prices

# 시스템 상태
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

## 운영자 정보

### 수익 구조

1. **운영 수수료**: 1.5% 고정 (수정 불가)
2. **DEX 수수료**: 0.3% (유동성 공급자에게 분배)
3. **DeFi 수수료**: 대출 이자의 일부

### 자동화된 작업

- **5분마다**: 운영 수수료 BTC 변환 및 수집
- **10분마다**: DEX 풀 리밸런싱
- **30분마다**: DeFi 청산 확인
- **매시간**: 자동 채굴자 지불
- **24시간마다**: 데이터베이스 최적화 및 백업

### 모니터링

대시보드: `http://localhost:8080`

주요 지표:
- 활성 채굴자
- 해시레이트
- 수수료 수익
- DEX 거래량
- 시스템 리소스

---

## 보안

### 구현된 보호 기능

1. **DDoS 방어**
   - 다층 속도 제한
   - 적응형 임계값
   - 챌린지-응답

2. **인증 시스템**
   - JWT + MFA
   - 역할 기반 접근 제어
   - API 키 관리

3. **변조 방지**
   - 불변 운영 수수료 주소
   - 시스템 무결성 검사
   - 감사 로그

---

## 문제 해결

### 포트 사용 중
```bash
# 포트 사용 프로세스 확인
netstat -tulpn | grep :8080

# 프로세스 중지
kill -9 PID
```

### 메모리 문제
```bash
# Node.js 메모리 제한 증가
export NODE_OPTIONS="--max-old-space-size=8192"
```

### 디버그 모드
```bash
DEBUG=* node index.js
```

---

## 성능 최적화

### 최적화 기능

- **데이터베이스 배치 처리**: 70% 빠름
- **네트워크 최적화**: 40% 대역폭 감소
- **고급 캐싱**: 85%+ 적중률
- **제로 카피 작업**: 효율적인 채굴 처리

### 벤치마크 결과

```bash
# 벤치마크 실행
npm run benchmark

# 결과 (8코어, 16GB RAM):
- 데이터베이스: 50,000+ ops/초
- 네트워크: 10,000+ msg/초
- 캐시 적중률: 85%+
- 메모리 사용량: <100MB (기본)
```

---

## 라이센스

MIT 라이센스 - 상업적 사용 허용

## 지원

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - 자동화된 채굴의 미래

---