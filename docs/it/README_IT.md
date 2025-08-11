# Otedama - Pool di Mining P2P e Software di Mining Aziendale

**Versione**: 2.1.6  
**Licenza**: MIT  
**Versione Go**: 1.21+  
**Architettura**: Microservizi con supporto pool P2P  
**Data di rilascio**: 6 agosto 2025

Otedama è un pool di mining P2P e software di mining di livello aziendale progettato per massima efficienza e affidabilità. Costruito seguendo i principi di progettazione di John Carmack (performance), Robert C. Martin (architettura pulita) e Rob Pike (semplicità), supporta mining completo CPU/GPU/ASIC con scalabilità a livello nazionale.

## Architettura

### Pool di Mining P2P
- **Gestione Pool Distribuita**: Pool di mining distribuito con failover automatico
- **Distribuzione Ricompense**: Algoritmi PPS/PPLNS avanzati con supporto multi-valuta
- **Protocollo di Federazione**: Comunicazione inter-pool per maggiore resilienza
- **Monitoraggio a Livello Nazionale**: Monitoraggio aziendale adatto per implementazioni governative

### Caratteristiche di Mining
- **Multi-Algoritmo**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Hardware Universale**: Ottimizzato per CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Avanzato**: Supporto completo v1/v2 con estensioni per miner ad alte prestazioni
- **Ottimizzazioni Zero-Copy**: Strutture dati cache-aware e memoria NUMA-aware

### Caratteristiche Aziendali
- **Pronto per Produzione**: Deployment Docker/Kubernetes con auto-scaling
- **Sicurezza Aziendale**: Protezione DDoS, rate limiting, auditing completo
- **Alta Disponibilità**: Setup multi-nodo con failover automatico
- **Analytics in Tempo Reale**: API WebSocket con integrazione dashboard live

## Requisiti

- Go 1.21 o superiore
- Linux, macOS, Windows
- Hardware di mining (CPU/GPU/ASIC)
- Connessione di rete al pool di mining

## Installazione

### Da sorgenti

```bash
# Costruire nella directory sorgente
cd Otedama

# Costruire binario
make build

# Installare nel sistema
make install
```

### Usare Go Build

```bash
go build ./cmd/otedama
```

### Docker Produzione

```bash
# Deployment di produzione
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Deployare stack completo
kubectl apply -f k8s/
```

## Avvio Rapido

### 1. Configurazione

```yaml
# Configurazione di produzione con supporto pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-rilevamento
    priority: "normal"
  
  gpu:
    devices: [] # Rilevare automaticamente tutti i dispositivi
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

### 2. Opzioni di Deployment

```bash
# Sviluppo
./otedama serve --config config.yaml

# Docker di Produzione
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Aziendale
kubectl apply -f k8s/

# Deployment manuale di produzione
sudo ./scripts/production-deploy.sh
```

### 3. Monitoraggio Performance

```bash
# Controllare stato
./otedama status

# Visualizzare log
tail -f logs/otedama.log

# Endpoint API
curl http://localhost:8080/api/status
```

## Performance

Otedama è ottimizzato per massima efficienza:

- **Uso Memoria**: Ottimizzato per footprint di memoria minimo
- **Dimensione Binario**: Dimensione compatta (~15MB)
- **Tempo di Avvio**: <500ms
- **Overhead CPU**: <1% per monitoraggio

## Riferimento API

### Endpoint REST

- `GET /api/status` - Stato mining
- `GET /api/stats` - Statistiche dettagliate
- `GET /api/workers` - Informazioni worker
- `POST /api/mining/start` - Avviare mining
- `POST /api/mining/stop` - Fermare mining

### WebSocket

Connettere a `ws://localhost:8080/api/ws` per aggiornamenti in tempo reale.

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

## Contribuzione

I contributi sono benvenuti! Seguire le pratiche di sviluppo standard:

1. Creare branch feature
2. Effettuare modifiche
3. Testare accuratamente
4. Inviare per revisione

## Licenza

Questo progetto è concesso in licenza sotto la Licenza MIT - vedere il file [LICENSE](LICENSE) per dettagli.

## Riconoscimenti

- Sviluppatori Bitcoin Core per protocolli di mining
- Comunità Go per eccellenti librerie
- Tutti i contributori e utenti di Otedama

## Supporto

- Controllare la documentazione nella directory `docs/`
- Rivedere esempi di configurazione in `config.example.yaml`
- Consultare la documentazione API a `/api/docs` durante l'esecuzione

## Donazioni

Se trovi utile Otedama, considera di supportare lo sviluppo:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Il tuo supporto aiuta a mantenere e migliorare Otedama!

---

**⚠️ Importante**: Il mining di criptovalute consume risorse computazionali ed elettriche significative. Si prega di comprendere i costi e l'impatto ambientale prima di iniziare il mining.