# Otedama - Enterprise P2P Mining Pool & Mining Software

**Version**: 2.1.6  
**Lizenz**: MIT  
**Go Version**: 1.21+  
**Architektur**: Mikroservices mit P2P Pool Unterstützung  
**Veröffentlichungsdatum**: 6. August 2025

Otedama ist ein Enterprise-Grade P2P Mining Pool und Mining Software, die für maximale Effizienz und Zuverlässigkeit entwickelt wurde. Gebaut nach den Designprinzipien von John Carmack (Performance), Robert C. Martin (Clean Architecture) und Rob Pike (Einfachheit), unterstützt es umfassendes CPU/GPU/ASIC Mining mit nationaler Skalierbarkeit.

## Architektur

### P2P Mining Pool
- **Verteiltes Pool Management**: Verteilter Mining Pool mit automatischem Failover
- **Belohnungsverteilung**: Erweiterte PPS/PPLNS Algorithmen mit Multi-Währungsunterstützung
- **Föderationsprotokoll**: Inter-Pool Kommunikation für erhöhte Widerstandsfähigkeit
- **Monitoring auf nationaler Ebene**: Enterprise Monitoring geeignet für Regierungsdeployments

### Mining Funktionen
- **Multi-Algorithmus**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universelle Hardware**: Optimiert für CPU, GPU (CUDA/OpenCL), ASIC
- **Erweiterte Stratum**: Vollständige v1/v2 Unterstützung mit Erweiterungen für Hochleistungs-Miner
- **Zero-Copy Optimierungen**: Cache-bewusste Datenstrukturen und NUMA-bewusster Speicher

### Enterprise Funktionen
- **Produktionsbereit**: Docker/Kubernetes Deployment mit Auto-Scaling
- **Enterprise Sicherheit**: DDoS Schutz, Rate Limiting, umfassendes Auditing
- **Hochverfügbarkeit**: Multi-Node Setup mit automatischem Failover
- **Echtzeit Analytics**: WebSocket API mit Live Dashboard Integration

## Anforderungen

- Go 1.21 oder höher
- Linux, macOS, Windows
- Mining Hardware (CPU/GPU/ASIC)
- Netzwerkverbindung zum Mining Pool

## Installation

### Aus Quellcode

```bash
# Im Quellcode-Verzeichnis bauen
cd Otedama

# Binary bauen
make build

# Im System installieren
make install
```

### Go Build verwenden

```bash
go build ./cmd/otedama
```

### Docker Produktion

```bash
# Produktions-Deployment
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Vollständigen Stack deployen
kubectl apply -f k8s/
```

## Schnellstart

### 1. Konfiguration

```yaml
# Produktionskonfiguration mit P2P Pool Unterstützung
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-Erkennung
    priority: "normal"
  
  gpu:
    devices: [] # Alle Geräte automatisch erkennen
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-Discovery
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

### 2. Deployment Optionen

```bash
# Entwicklung
./otedama serve --config config.yaml

# Produktions Docker
docker-compose -f docker-compose.production.yml up -d

# Enterprise Kubernetes
kubectl apply -f k8s/

# Manuelles Produktions-Deployment
sudo ./scripts/production-deploy.sh
```

### 3. Performance Monitoring

```bash
# Status prüfen
./otedama status

# Logs anzeigen
tail -f logs/otedama.log

# API Endpoint
curl http://localhost:8080/api/status
```

## Performance

Otedama ist für maximale Effizienz optimiert:

- **Speicherverbrauch**: Optimiert für minimalen Speicher-Footprint
- **Binary-Größe**: Kompakte Größe (~15MB)
- **Startzeit**: <500ms
- **CPU Overhead**: <1% für Monitoring

## API Referenz

### REST Endpoints

- `GET /api/status` - Mining Status
- `GET /api/stats` - Detaillierte Statistiken
- `GET /api/workers` - Worker Informationen
- `POST /api/mining/start` - Mining starten
- `POST /api/mining/stop` - Mining stoppen

### WebSocket

Verbinde zu `ws://localhost:8080/api/ws` für Echtzeit-Updates.

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

## Beitragen

Beiträge sind willkommen! Bitte folgen Sie den Standard-Entwicklungspraktiken:

1. Feature Branch erstellen
2. Änderungen vornehmen
3. Gründlich testen
4. Zur Überprüfung einreichen

## Lizenz

Dieses Projekt ist unter der MIT-Lizenz lizenziert - siehe [LICENSE](LICENSE) Datei für Details.

## Danksagungen

- Bitcoin Core Entwicklern für Mining-Protokolle
- Go Community für ausgezeichnete Bibliotheken
- Alle Mitwirkenden und Nutzer von Otedama

## Support

- Überprüfen Sie die Dokumentation im `docs/` Verzeichnis
- Überprüfen Sie Konfigurationsbeispiele in `config.example.yaml`
- Konsultieren Sie die API-Dokumentation unter `/api/docs` während der Ausführung

## Spenden

Wenn Sie Otedama nützlich finden, erwägen Sie bitte eine Unterstützung der Entwicklung:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Ihre Unterstützung hilft bei der Wartung und Verbesserung von Otedama!

---

**⚠️ Wichtig**: Kryptowährungs-Mining verbraucht erhebliche Rechenressourcen und Strom. Bitte verstehen Sie die Kosten und Umweltauswirkungen vor dem Mining.