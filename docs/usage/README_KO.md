# Otedama - P2P 마이닝 풀 소프트웨어 사용 가이드

## 목차
1. [설치](#설치)
2. [구성](#구성)
3. [Otedama 실행](#otedama-실행)
4. [마이닝 작업](#마이닝-작업)
5. [풀 관리](#풀-관리)
6. [모니터링](#모니터링)
7. [문제 해결](#문제-해결)

## 설치

### 시스템 요구사항
- 운영체제: Linux, Windows, macOS
- RAM: 최소 4GB, 권장 8GB+
- 저장소: 50GB+ 여유 공간
- 네트워크: 안정적인 인터넷 연결

### 빠른 설치
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## 구성
알고리즘, 스레드, 풀 URL, 지갑 주소로 `config.yaml` 생성.

## Otedama 실행
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet 주소 --worker worker1
```

## 지원
- GitHub: https://github.com/otedama/otedama
