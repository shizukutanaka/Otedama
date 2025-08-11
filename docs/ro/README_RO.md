# Otedama - Pool de Minerit P2P și Software de Minerit Enterprise

**Licență**: MIT  
**Versiune Go**: 1.21+  
**Arhitectură**: Microservicii cu suport pentru pool P2P  

Otedama este un pool de minerit P2P și software de minerit de nivel enterprise proiectat pentru eficiență și fiabilitate maximă. Construit conform principiilor de design ale lui John Carmack (performanță), Robert C. Martin (arhitectură curată) și Rob Pike (simplitate), suportă minerit cuprinzător CPU/GPU/ASIC cu scalabilitate la nivel național.

## Arhitectură

### Pool de Minerit P2P
- **Management Distribuit al Pool-ului**: Pool de minerit distribuit cu failover automat
- **Distribuția Recompenselor**: Algoritmi avansați PPS/PPLNS cu suport multi-monedă
- **Protocol de Federație**: Comunicare între pool-uri pentru reziliență îmbunătățită
- **Monitorizare la Nivel Național**: Monitorizare enterprise potrivită pentru implementări guvernamentale

### Caracteristici de Minerit
- **Multi-Algoritm**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Hardware Universal**: Optimizat pentru CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Avansat**: Suport complet v1/v2 cu extensii pentru mineri de înaltă performanță
- **Optimizări Zero-Copy**: Structuri de date conștiente de cache și memorie conștientă de NUMA

### Caracteristici Enterprise
- **Pregătit pentru Producție**: Implementare Docker/Kubernetes cu auto-scalare
- **Securitate Enterprise**: Protecție DDoS, limitare de rată, auditare cuprinzătoare
- **Disponibilitate Înaltă**: Configurare multi-nod cu failover automat
- **Analiză în Timp Real**: API WebSocket cu integrare dashboard live

## Cerințe

- Go 1.21 sau mai nou
- Linux, macOS, Windows
- Hardware de minerit (CPU/GPU/ASIC)
- Conexiune de rețea la pool-ul de minerit

## Instalare

### Din cod sursă

```bash
# Construire în directorul sursă
cd Otedama

# Construire binar
make build

# Instalare în sistem
make install
```

### Folosind Go Build

```bash
go build ./cmd/otedama
```

### Docker Producție

```bash
# Implementare de producție
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Implementare stack complet
kubectl apply -f k8s/
```

## Start Rapid

### 1. Configurare

```yaml
# Configurare de producție cu suport pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detecție
    priority: "normal"
  
  gpu:
    devices: [] # Auto-detectare toate dispozitivele
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-descoperire
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

### 2. Opțiuni de Implementare

```bash
# Dezvoltare
./otedama serve --config config.yaml

# Docker Producție
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Enterprise
kubectl apply -f k8s/

# Implementare manuală de producție
sudo ./scripts/production-deploy.sh
```

### 3. Monitorizare Performanță

```bash
# Verificare status
./otedama status

# Vizualizare log-uri
tail -f logs/otedama.log

# Endpoint API
curl http://localhost:8080/api/status
```

## Performanță

Otedama este optimizat pentru eficiență maximă:

- **Utilizare Memorie**: Optimizat pentru amprentă minimă de memorie
- **Dimensiune Binar**: Dimensiune compactă (~15MB)
- **Timp de Pornire**: <500ms
- **Overhead CPU**: <1% pentru monitorizare

## Referință API

### Endpoint-uri REST

- `GET /api/status` - Status minerit
- `GET /api/stats` - Statistici detaliate
- `GET /api/workers` - Informații muncitori
- `POST /api/mining/start` - Pornire minerit
- `POST /api/mining/stop` - Oprire minerit

### WebSocket

Conectați-vă la `ws://localhost:8080/api/ws` pentru actualizări în timp real.

## Implementare

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

## Contribuții

Contribuțiile sunt binevenite! Vă rugăm să urmați practicile standard de dezvoltare:

1. Creați ramură de funcționalitate
2. Faceți modificări
3. Testați temeinic
4. Trimiteți pentru revizuire

## Licență

Acest proiect este licențiat sub Licența MIT - vedeți fișierul [LICENSE](LICENSE) pentru detalii.

## Mulțumiri

- Dezvoltatorii Bitcoin Core pentru protocoalele de minerit
- Comunitatea Go pentru biblioteci excelente
- Toți contribuitorii și utilizatorii Otedama

## Suport

- Verificați documentația în directorul `docs/`
- Revizuiți exemple de configurare în `config.example.yaml`
- Consultați documentația API la `/api/docs` în timpul rulării

## Donații

Dacă găsiți Otedama util, vă rugăm să considerați susținerea dezvoltării:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Suportul dvs. ajută la menținerea și îmbunătățirea Otedama!

---

**⚠️ Important**: Mineritul de criptomonede consumă resurse computaționale și electricitate semnificative. Vă rugăm să înțelegeți costurile și impactul asupra mediului înainte de a începe mineritul.