# Otedama - Företags P2P Mining Pool & Mining Mjukvara

**Version**: 2.1.5  
**Licens**: MIT  
**Go Version**: 1.21+  
**Arkitektur**: Mikrotjänster med P2P pool support  
**Utgivningsdatum**: 6 augusti 2025

Otedama är en företagsgradig P2P mining pool och mining mjukvara designad för maximal effektivitet och tillförlitlighet. Byggd enligt designprinciperna från John Carmack (prestanda), Robert C. Martin (ren arkitektur) och Rob Pike (enkelhet), stöder den omfattande CPU/GPU/ASIC mining med nationell skalbarhet.

## Arkitektur

### P2P Mining Pool
- **Distribuerad Poolhantering**: Distribuerad mining pool med automatisk failover
- **Belöningsdistribution**: Avancerade PPS/PPLNS algoritmer med multi-valuta support
- **Federationsprotokoll**: Inter-pool kommunikation för förbättrad motståndskraft
- **Nationell Nivå Övervakning**: Företagsövervakning lämplig för regeringsinstallationer

### Mining Funktioner
- **Multi-Algoritm**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universell Hårdvara**: Optimerad för CPU, GPU (CUDA/OpenCL), ASIC
- **Avancerad Stratum**: Fullständig v1/v2 support med tillägg för högpresterande miners
- **Zero-Copy Optimeringar**: Cache-medvetna datastrukturer och NUMA-medvetet minne

### Företagsfunktioner
- **Produktionsklar**: Docker/Kubernetes deployment med auto-skalning
- **Företagssäkerhet**: DDoS skydd, hastighetsbegränsning, omfattande revision
- **Hög Tillgänglighet**: Multi-nod setup med automatisk failover
- **Realtidsanalys**: WebSocket API med live dashboard integration

## Krav

- Go 1.21 eller högre
- Linux, macOS, Windows
- Mining hårdvara (CPU/GPU/ASIC)
- Nätverksanslutning till mining pool

## Installation

### Från källkod

```bash
# Bygg i källkodskatalog
cd Otedama

# Bygg binär
make build

# Installera i system
make install
```

### Använd Go Build

```bash
go build ./cmd/otedama
```

### Docker Produktion

```bash
# Produktionsdistribution
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Distribuera full stack
kubectl apply -f k8s/
```

## Snabbstart

### 1. Konfiguration

```yaml
# Produktionskonfiguration med P2P pool support
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detektering
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detektera alla enheter
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-upptäckt
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

### 2. Distributionsalternativ

```bash
# Utveckling
./otedama serve --config config.yaml

# Produktion Docker
docker-compose -f docker-compose.production.yml up -d

# Företag Kubernetes
kubectl apply -f k8s/

# Manuell produktionsdistribution
sudo ./scripts/production-deploy.sh
```

### 3. Prestandaövervakning

```bash
# Kontrollera status
./otedama status

# Visa loggar
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Prestanda

Otedama är optimerad för maximal effektivitet:

- **Minnesanvändning**: Optimerad för minimal minnesavtryck
- **Binärstorlek**: Kompakt storlek (~15MB)
- **Starttid**: <500ms
- **CPU Overhead**: <1% för övervakning

## API Referens

### REST Endpoints

- `GET /api/status` - Mining status
- `GET /api/stats` - Detaljerad statistik
- `GET /api/workers` - Worker information
- `POST /api/mining/start` - Starta mining
- `POST /api/mining/stop` - Stoppa mining

### WebSocket

Anslut till `ws://localhost:8080/api/ws` för realtidsuppdateringar.

## Distribution

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

## Bidrag

Bidrag är välkomna! Följ standard utvecklingspraxis:

1. Skapa funktionsgren
2. Gör ändringar
3. Testa noggrant
4. Skicka för granskning

## Licens

Detta projekt är licensierat under MIT License - se [LICENSE](LICENSE) filen för detaljer.

## Erkännanden

- Bitcoin Core utvecklare för mining protokoll
- Go communityn för utmärkta bibliotek
- Alla bidragsgivare och användare av Otedama

## Support

- Kontrollera dokumentation i `docs/` katalogen
- Granska konfigurationsexempel i `config.example.yaml`
- Konsultera API dokumentation på `/api/docs` under körning

## Donationer

Om du tycker Otedama är användbar, överväg att stödja utvecklingen:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Ditt stöd hjälper att underhålla och förbättra Otedama!

---

**⚠️ Viktigt**: Kryptovaluta mining konsumerar betydande beräkningsresurser och elektricitet. Vänligen förstå kostnaderna och miljöpåverkan innan du börjar mining.