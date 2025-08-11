# Otedama - Enterprise P2P Mining Pool & Mining Software

**Versie**: 2.1.6  
**Licentie**: MIT  
**Go Versie**: 1.21+  
**Architectuur**: Microservices met P2P pool ondersteuning  
**Releasedatum**: 6 augustus 2025

Otedama is een enterprise-grade P2P mining pool en mining software ontworpen voor maximale efficiëntie en betrouwbaarheid. Gebouwd volgens de ontwerpprincipes van John Carmack (prestaties), Robert C. Martin (schone architectuur) en Rob Pike (eenvoud), ondersteunt het uitgebreide CPU/GPU/ASIC mining met nationale schaalbaarheid.

## Architectuur

### P2P Mining Pool
- **Gedistribueerd Pool Beheer**: Gedistribueerde mining pool met automatische failover
- **Beloningsdistributie**: Geavanceerde PPS/PPLNS algoritmen met multi-valuta ondersteuning
- **Federatie Protocol**: Inter-pool communicatie voor verbeterde veerkracht
- **Nationale Monitoring**: Enterprise monitoring geschikt voor overheidsimplementaties

### Mining Functies
- **Multi-Algoritme**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universele Hardware**: Geoptimaliseerd voor CPU, GPU (CUDA/OpenCL), ASIC
- **Geavanceerde Stratum**: Volledige v1/v2 ondersteuning met extensies voor high-performance miners
- **Zero-Copy Optimalisaties**: Cache-bewuste datastructuren en NUMA-bewust geheugen

### Enterprise Functies
- **Productie Klaar**: Docker/Kubernetes deployment met auto-scaling
- **Enterprise Beveiliging**: DDoS bescherming, rate limiting, uitgebreide auditing
- **Hoge Beschikbaarheid**: Multi-node setup met automatische failover
- **Realtime Analytics**: WebSocket API met live dashboard integratie

## Vereisten

- Go 1.21 of hoger
- Linux, macOS, Windows
- Mining hardware (CPU/GPU/ASIC)
- Netwerkverbinding naar mining pool

## Installatie

### Vanuit broncode

```bash
# Bouwen in broncode directory
cd Otedama

# Binair bouwen
make build

# Installeren in systeem
make install
```

### Go Build Gebruiken

```bash
go build ./cmd/otedama
```

### Docker Productie

```bash
# Productie deployment
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Volledige stack deployen
kubectl apply -f k8s/
```

## Snelle Start

### 1. Configuratie

```yaml
# Productie configuratie met P2P pool ondersteuning
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detectie
    priority: "normal"
  
  gpu:
    devices: [] # Automatisch alle apparaten detecteren
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-discovery
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

### 2. Deployment Opties

```bash
# Ontwikkeling
./otedama serve --config config.yaml

# Productie Docker
docker-compose -f docker-compose.production.yml up -d

# Enterprise Kubernetes
kubectl apply -f k8s/

# Handmatige productie deployment
sudo ./scripts/production-deploy.sh
```

### 3. Prestatie Monitoring

```bash
# Status controleren
./otedama status

# Logs bekijken
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Prestaties

Otedama is geoptimaliseerd voor maximale efficiëntie:

- **Geheugengebruik**: Geoptimaliseerd voor minimale geheugenvoetafdruk
- **Binaire Grootte**: Compacte grootte (~15MB)
- **Opstarttijd**: <500ms
- **CPU Overhead**: <1% voor monitoring

## API Referentie

### REST Endpoints

- `GET /api/status` - Mining status
- `GET /api/stats` - Gedetailleerde statistieken
- `GET /api/workers` - Worker informatie
- `POST /api/mining/start` - Mining starten
- `POST /api/mining/stop` - Mining stoppen

### WebSocket

Verbinden met `ws://localhost:8080/api/ws` voor realtime updates.

## Deployment

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

## Bijdragen

Bijdragen zijn welkom! Volg standaard ontwikkelingspraktijken:

1. Feature branch aanmaken
2. Wijzigingen doorvoeren
3. Grondig testen
4. Indienen voor review

## Licentie

Dit project is gelicenseerd onder de MIT Licentie - zie het [LICENSE](LICENSE) bestand voor details.

## Dankbetuigingen

- Bitcoin Core ontwikkelaars voor mining protocollen
- Go gemeenschap voor uitstekende libraries
- Alle bijdragers en gebruikers van Otedama

## Ondersteuning

- Controleer documentatie in `docs/` directory
- Bekijk configuratie voorbeelden in `config.example.yaml`
- Raadpleeg API documentatie op `/api/docs` tijdens uitvoering

## Donaties

Als je Otedama nuttig vindt, overweeg dan om de ontwikkeling te ondersteunen:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Je ondersteuning helpt bij het onderhouden en verbeteren van Otedama!

---

**⚠️ Belangrijk**: Cryptocurrency mining verbruikt aanzienlijke computationele middelen en elektriciteit. Begrijp de kosten en milieu-impact voordat je begint met mining.