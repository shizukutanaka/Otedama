# Otedama - 엔터프라이즈 P2P 마이닝 풀 및 마이닝 소프트웨어

**버전**: 2.1.6  
**라이선스**: MIT  
**Go 버전**: 1.21+  
**아키텍처**: P2P 풀 지원 마이크로서비스  
**출시일**: 2025년 8월 6일

Otedama는 최대 효율성과 신뢰성을 추구하여 설계된 엔터프라이즈급 P2P 마이닝 풀 및 마이닝 소프트웨어입니다. John Carmack(성능), Robert C. Martin(클린 아키텍처), Rob Pike(단순성)의 설계 원칙을 따라 구축되었으며, 국가 수준의 확장성을 가진 포괄적인 CPU/GPU/ASIC 마이닝을 지원합니다.

## 아키텍처

### P2P 마이닝 풀
- **분산 풀 관리**: 자동 장애 조치 기능이 있는 분산 마이닝 풀
- **보상 분배**: 다중 통화 지원 고급 PPS/PPLNS 알고리즘
- **연방 프로토콜**: 향상된 탄력성을 위한 풀 간 통신
- **국가 수준 모니터링**: 정부 배포에 적합한 엔터프라이즈 모니터링

### 마이닝 기능
- **멀티 알고리즘**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **범용 하드웨어**: CPU, GPU(CUDA/OpenCL), ASIC에 최적화
- **고급 Stratum**: 고성능 마이너용 확장 기능이 있는 완전한 v1/v2 지원
- **제로 카피 최적화**: 캐시 인식 데이터 구조 및 NUMA 인식 메모리

### 엔터프라이즈 기능
- **프로덕션 준비**: 자동 스케일링이 있는 Docker/Kubernetes 배포
- **엔터프라이즈 보안**: DDoS 보호, 속도 제한, 포괄적 감사
- **고가용성**: 자동 장애 조치가 있는 다중 노드 설정
- **실시간 분석**: 라이브 대시보드 통합이 있는 WebSocket API

## 요구사항

- Go 1.21 이상
- Linux, macOS, Windows
- 마이닝 하드웨어 (CPU/GPU/ASIC)
- 마이닝 풀에 대한 네트워크 연결

## 설치

### 소스에서 설치

```bash
# 소스 디렉토리에서 빌드
cd Otedama

# 바이너리 빌드
make build

# 시스템에 설치
make install
```

### Go Build 사용

```bash
go build ./cmd/otedama
```

### Docker 프로덕션

```bash
# 프로덕션 배포
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# 전체 스택 배포
kubectl apply -f k8s/
```

## 빠른 시작

### 1. 구성

```yaml
# P2P 풀 지원 프로덕션 구성
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # 자동 감지
    priority: "normal"
  
  gpu:
    devices: [] # 모든 장치 자동 감지
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # 자동 발견
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

### 2. 배포 옵션

```bash
# 개발
./otedama serve --config config.yaml

# 프로덕션 Docker
docker-compose -f docker-compose.production.yml up -d

# 엔터프라이즈 Kubernetes
kubectl apply -f k8s/

# 수동 프로덕션 배포
sudo ./scripts/production-deploy.sh
```

### 3. 성능 모니터링

```bash
# 상태 확인
./otedama status

# 로그 보기
tail -f logs/otedama.log

# API 엔드포인트
curl http://localhost:8080/api/status
```

## 성능

Otedama는 최대 효율성을 위해 최적화되었습니다:

- **메모리 사용량**: 최소 메모리 사용량으로 최적화
- **바이너리 크기**: 컴팩트 크기 (~15MB)
- **시작 시간**: <500ms
- **CPU 오버헤드**: 모니터링에 <1%

## API 참조

### REST 엔드포인트

- `GET /api/status` - 마이닝 상태
- `GET /api/stats` - 상세 통계
- `GET /api/workers` - 워커 정보
- `POST /api/mining/start` - 마이닝 시작
- `POST /api/mining/stop` - 마이닝 중지

### WebSocket

실시간 업데이트를 위해 `ws://localhost:8080/api/ws`에 연결하세요.

## 배포

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

## 기여

기여를 환영합니다! 표준 개발 관행을 따라주세요:

1. 기능 브랜치 생성
2. 변경 사항 적용
3. 철저한 테스트
4. 검토를 위해 제출

## 라이선스

이 프로젝트는 MIT 라이선스 하에 라이선스됩니다 - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## 감사의 말

- 마이닝 프로토콜을 위한 Bitcoin Core 개발자들
- 훌륭한 라이브러리를 위한 Go 커뮤니티
- Otedama의 모든 기여자와 사용자들

## 지원

- `docs/` 디렉토리의 문서 확인
- `config.example.yaml`의 구성 예제 검토
- 실행 시 `/api/docs`에서 API 문서 참조

## 기부

Otedama가 유용하다고 생각되시면 개발 지원을 고려해 주세요:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

귀하의 지원은 Otedama의 유지보수와 개선에 도움이 됩니다!

---

**⚠️ 중요**: 암호화폐 마이닝은 상당한 계산 자원과 전력을 소비합니다. 마이닝을 시작하기 전에 비용과 환경 영향을 이해하시기 바랍니다.