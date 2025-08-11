# Otedama - Virksomheds P2P Mining Pool & Mining Software

**Licens**: MIT  
**Go Version**: 1.21+  
**Arkitektur**: Microservices med P2P pool understøttelse  

Otedama er en virksomhedsklasse P2P mining pool og mining software designet til maksimal effektivitet og pålidelighed. Bygget efter designprincipperne fra John Carmack (ydeevne), Robert C. Martin (ren arkitektur) og Rob Pike (enkelhed), understøtter den omfattende CPU/GPU/ASIC mining med national skalerbarhed.

## Arkitektur

### P2P Mining Pool
- **Distribueret Pool Håndtering**: Distribueret mining pool med automatisk failover
- **Belønningsfordeling**: Avancerede PPS/PPLNS algoritmer med multi-valuta understøttelse
- **Føderationsprotokol**: Inter-pool kommunikation for øget modstandsdygtighed
- **Nationalt Niveau Overvågning**: Virksomhedsovervågning egnet til regeringsinstallationer

### Mining Funktioner
- **Multi-Algoritme**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universal Hardware**: Optimeret til CPU, GPU (CUDA/OpenCL), ASIC
- **Avanceret Stratum**: Fuld v1/v2 understøttelse med udvidelser til højtydende minere
- **Zero-Copy Optimeringer**: Cache-bevidste datastrukturer og NUMA-bevidst hukommelse

### Virksomhedsfunktioner
- **Produktionsklar**: Docker/Kubernetes udrulning med auto-skalering
- **Virksomhedssikkerhed**: DDoS beskyttelse, hastighedsbegrænsning, omfattende revision
- **Høj Tilgængelighed**: Multi-node opsætning med automatisk failover
- **Realtidsanalyse**: WebSocket API med live dashboard integration

## Krav

- Go 1.21 eller højere
- Linux, macOS, Windows
- Mining hardware (CPU/GPU/ASIC)
- Netværksforbindelse til mining pool

## Installation

### Fra kildekode

```bash
# Byg i kildekodemappe
cd Otedama

# Byg binær
make build

# Installer i system
make install
```

### Brug Go Build

```bash
go build ./cmd/otedama
```

### Docker Produktion

```bash
# Produktionsudrulning
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Udrul fuld stak
kubectl apply -f k8s/
```

## Hurtig Start

### 1. Konfiguration

```yaml
# Produktionskonfiguration med P2P pool understøttelse
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detektion
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detekter alle enheder
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-opdagelse
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

### 2. Udrulningsmuligheder

```bash
# Udvikling
./otedama serve --config config.yaml

# Produktion Docker
docker-compose -f docker-compose.production.yml up -d

# Virksomhed Kubernetes
kubectl apply -f k8s/

# Manuel produktionsudrulning
sudo ./scripts/production-deploy.sh
```

### 3. Ydeevneovervågning

```bash
# Tjek status
./otedama status

# Vis logfiler
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Ydeevne

Otedama er optimeret til maksimal effektivitet:

- **Hukommelsesforbrug**: Optimeret til minimal hukommelsesaftryk
- **Binær Størrelse**: Kompakt størrelse (~15MB)
- **Opstartstid**: <500ms
- **CPU Overhead**: <1% til overvågning

## API Reference

### REST Endpoints

- `GET /api/status` - Mining status
- `GET /api/stats` - Detaljeret statistik
- `GET /api/workers` - Worker information
- `POST /api/mining/start` - Start mining
- `POST /api/mining/stop` - Stop mining

### WebSocket

Forbind til `ws://localhost:8080/api/ws` for realtidsopdateringer.

## Udrulning

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

Bidrag er velkomne! Følg standard udviklingspraksis:

1. Opret funktionsgren
2. Foretag ændringer
3. Test grundigt
4. Indsend til gennemgang

## Licens

Dette projekt er licenseret under MIT License - se [LICENSE](LICENSE) filen for detaljer.

## Anerkendelser

- Bitcoin Core udviklere for mining protokoller
- Go fællesskabet for fremragende biblioteker
- Alle bidragydere og brugere af Otedama

## Support

- Tjek dokumentation i `docs/` mappen
- Gennemgå konfigurationseksempler i `config.example.yaml`
- Konsulter API dokumentation på `/api/docs` under kørsel

## Donationer

Hvis du finder Otedama nyttig, overvej at støtte udviklingen:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Din støtte hjælper med at vedligeholde og forbedre Otedama!

---

**⚠️ Vigtigt**: Cryptocurrency mining forbruger betydelige beregningsressourcer og elektricitet. Forstå venligst omkostningerne og miljøpåvirkningen før du starter mining.