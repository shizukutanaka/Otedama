# Otedama - Bedrifts P2P Mining Pool & Mining Programvare

**Versjon**: 2.1.6  
**Lisens**: MIT  
**Go Versjon**: 1.21+  
**Arkitektur**: Mikrotjenester med P2P pool støtte  
**Utgivelsesdato**: 6. august 2025

Otedama er en bedriftsklasse P2P mining pool og mining programvare designet for maksimal effektivitet og pålitelighet. Bygget etter designprinsippene til John Carmack (ytelse), Robert C. Martin (ren arkitektur) og Rob Pike (enkelhet), støtter den omfattende CPU/GPU/ASIC mining med nasjonal skalerbarhet.

## Arkitektur

### P2P Mining Pool
- **Distribuert Pool Håndtering**: Distribuert mining pool med automatisk failover
- **Belønningsfordeling**: Avanserte PPS/PPLNS algoritmer med multi-valuta støtte
- **Føderasjonsprotokoll**: Inter-pool kommunikasjon for økt motstandsdyktighet
- **Nasjonalt Nivå Overvåkning**: Bedriftsovervåkning egnet for offentlige installasjoner

### Mining Funksjoner
- **Multi-Algoritme**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universal Maskinvare**: Optimalisert for CPU, GPU (CUDA/OpenCL), ASIC
- **Avansert Stratum**: Full v1/v2 støtte med utvidelser for høyytelsesgruvearbeidere
- **Zero-Copy Optimaliseringer**: Cache-bevisste datastrukturer og NUMA-bevisst minne

### Bedriftsfunksjoner
- **Produksjonsklar**: Docker/Kubernetes utplassering med auto-skalering
- **Bedriftssikkerhet**: DDoS beskyttelse, hastighetsbegrensning, omfattende revisjon
- **Høy Tilgjengelighet**: Multi-node oppsett med automatisk failover
- **Sanntidsanalyse**: WebSocket API med live dashboard integrasjon

## Krav

- Go 1.21 eller høyere
- Linux, macOS, Windows
- Mining maskinvare (CPU/GPU/ASIC)
- Nettverkstilkobling til mining pool

## Installasjon

### Fra kildekode

```bash
# Bygg i kildekodekatalog
cd Otedama

# Bygg binær
make build

# Installer i system
make install
```

### Bruk Go Build

```bash
go build ./cmd/otedama
```

### Docker Produksjon

```bash
# Produksjonsutplassering
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Utplasser full stack
kubectl apply -f k8s/
```

## Hurtigstart

### 1. Konfigurasjon

```yaml
# Produksjonskonfigurasjon med P2P pool støtte
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-deteksjon
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detekter alle enheter
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-oppdagelse
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

### 2. Utplasseringsalternativer

```bash
# Utvikling
./otedama serve --config config.yaml

# Produksjon Docker
docker-compose -f docker-compose.production.yml up -d

# Bedrift Kubernetes
kubectl apply -f k8s/

# Manuell produksjonsutplassering
sudo ./scripts/production-deploy.sh
```

### 3. Ytelsesovervåkning

```bash
# Sjekk status
./otedama status

# Vis logger
tail -f logs/otedama.log

# API endepunkt
curl http://localhost:8080/api/status
```

## Ytelse

Otedama er optimalisert for maksimal effektivitet:

- **Minnebruk**: Optimalisert for minimal minneavtrykk
- **Binær Størrelse**: Kompakt størrelse (~15MB)
- **Oppstartstid**: <500ms
- **CPU Overhead**: <1% for overvåkning

## API Referanse

### REST Endepunkter

- `GET /api/status` - Mining status
- `GET /api/stats` - Detaljert statistikk
- `GET /api/workers` - Worker informasjon
- `POST /api/mining/start` - Start mining
- `POST /api/mining/stop` - Stopp mining

### WebSocket

Koble til `ws://localhost:8080/api/ws` for sanntidsoppdateringer.

## Utplassering

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

Bidrag er velkomne! Følg standard utviklingspraksis:

1. Opprett funksjonsgren
2. Gjør endringer
3. Test grundig
4. Send inn for gjennomgang

## Lisens

Dette prosjektet er lisensiert under MIT License - se [LICENSE](LICENSE) filen for detaljer.

## Anerkjennelser

- Bitcoin Core utviklere for mining protokoller
- Go fellesskapet for utmerkede biblioteker
- Alle bidragsytere og brukere av Otedama

## Støtte

- Sjekk dokumentasjon i `docs/` katalog
- Gjennomgå konfigurasjonseksempler i `config.example.yaml`
- Konsulter API dokumentasjon på `/api/docs` under kjøring

## Donasjoner

Hvis du synes Otedama er nyttig, vurder å støtte utviklingen:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Din støtte hjelper til med å vedlikeholde og forbedre Otedama!

---

**⚠️ Viktig**: Cryptocurrency mining forbruker betydelige beregningsressurser og strøm. Vennligst forstå kostnadene og miljøpåvirkningen før du starter mining.