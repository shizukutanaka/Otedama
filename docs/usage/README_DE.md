# Otedama - P2P Mining-Pool-Software Benutzerhandbuch

## Inhaltsverzeichnis
1. [Installation](#installation)
2. [Konfiguration](#konfiguration)
3. [Otedama ausführen](#otedama-ausführen)
4. [Mining-Operationen](#mining-operationen)
5. [Pool-Verwaltung](#pool-verwaltung)
6. [Überwachung](#überwachung)
7. [Fehlerbehebung](#fehlerbehebung)

## Installation

### Systemanforderungen
- Betriebssystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Empfohlen 8GB+
- Speicher: 50GB+ freier Speicherplatz
- Netzwerk: Stabile Internetverbindung

### Schnellinstallation
```bash
# Neueste Version herunterladen
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# Oder aus Quellcode kompilieren
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## Konfiguration

### Grundkonfiguration
Erstelle `config.yaml`:
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: IHRE_WALLET_ADRESSE
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

### Erweiterte Einstellungen
```yaml
hardware:
  cpu:
    enabled: true
    threads: 8
  gpu:
    enabled: true
    devices: [0, 1]
  asic:
    enabled: false

monitoring:
  enabled: true
  listen_addr: 0.0.0.0:8080
  prometheus_enabled: true
```

## Otedama ausführen

### Solo-Mining
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### Pool-Mining
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet IHRE_WALLET --worker worker1
```

### P2P-Pool-Modus
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

### Docker-Bereitstellung
```bash
docker run -d \
  --name otedama \
  -p 19333:19333 \
  -p 8080:8080 \
  -v ./config.yaml:/config.yaml \
  otedama/otedama:latest
```

## Mining-Operationen

### Unterstützte Algorithmen
- SHA256d (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- KawPow (Ravencoin)
- RandomX (Monero)
- Autolykos2 (Ergo)

### Hardware-Optimierung
```bash
# CPU-Mining mit SIMD-Optimierung
./otedama --cpu --optimize simd

# GPU-Mining mit mehreren Geräten
./otedama --gpu --devices 0,1,2,3

# ASIC-Mining
./otedama --asic --model antminer-s19
```

### Leistungsoptimierung
```bash
# Intensität anpassen (1-20)
./otedama --intensity 15

# Speicheroptimierung
./otedama --memory-pool 2048

# Netzwerkoptimierung
./otedama --low-latency --max-connections 100
```

## Pool-Verwaltung

### Pool-Server starten
```bash
./otedama pool --listen 0.0.0.0:3333 --fee 1.0 --min-payout 0.001
```

### Worker-Verwaltung
```bash
# Worker auflisten
./otedama workers list

# Worker hinzufügen
./otedama workers add --name worker1 --wallet ADRESSE

# Worker entfernen
./otedama workers remove worker1

# Worker-Statistiken anzeigen
./otedama workers stats worker1
```

### Auszahlungskonfiguration
```yaml
pool:
  payout_scheme: PPLNS  # oder PPS, PROP
  payout_interval: 24h
  min_payout: 0.001
  fee_percent: 1.0
```

## Überwachung

### Web-Dashboard
Zugriff unter `http://localhost:8080`

Funktionen:
- Echtzeit-Hashrate-Diagramme
- Worker-Statistiken
- Pool-Leistungsmetriken
- Auszahlungsverlauf

### Kommandozeilen-Überwachung
```bash
# Aktuelle Statistiken anzeigen
./otedama stats

# Echtzeitüberwachung
./otedama monitor

# Metriken exportieren
./otedama metrics export --format json
```

### Prometheus-Integration
```yaml
monitoring:
  prometheus_enabled: true
  prometheus_port: 9090
```

### Alarm-Konfiguration
```yaml
alerts:
  email:
    enabled: true
    smtp_server: smtp.gmail.com:587
    from: alerts@example.com
    to: admin@example.com
  thresholds:
    min_hashrate: 1000000
    max_temperature: 85
    min_workers: 5
```

## Fehlerbehebung

### Häufige Probleme

#### Verbindungsprobleme
```bash
# Pool-Verbindung testen
./otedama test --pool stratum+tcp://pool.example.com:3333

# Netzwerk debuggen
./otedama --debug --verbose
```

#### Leistungsprobleme
```bash
# Benchmark ausführen
./otedama benchmark --duration 60

# CPU-Nutzung profilieren
./otedama --profile cpu.prof
```

#### Hardware-Erkennung
```bash
# Hardware scannen
./otedama hardware scan

# Bestimmtes Gerät testen
./otedama hardware test --gpu 0
```

### Log-Dateien
```bash
# Logs anzeigen
tail -f /var/log/otedama/otedama.log

# Log-Level ändern
./otedama --log-level debug
```

### Wiederherstellungsmodus
```bash
# Im abgesicherten Modus starten
./otedama --safe-mode

# Konfiguration zurücksetzen
./otedama --reset-config

# Datenbank reparieren
./otedama db repair
```

## API-Referenz

### REST API
```bash
# Status abrufen
curl http://localhost:8080/api/status

# Worker abrufen
curl http://localhost:8080/api/workers

# Share einreichen
curl -X POST http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d '{"worker":"worker1","nonce":"12345678"}'
```

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('message', (data) => {
  console.log('Empfangen:', data);
});
```

## Sicherheit

### Authentifizierung
```yaml
security:
  auth_enabled: true
  jwt_secret: IHR_GEHEIMER_SCHLÜSSEL
  api_keys:
    - key: API_KEY_1
      permissions: [read, write]
```

### SSL/TLS
```yaml
security:
  tls_enabled: true
  cert_file: /path/to/cert.pem
  key_file: /path/to/key.pem
```

### Firewall-Regeln
```bash
# Stratum erlauben
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT

# P2P erlauben
iptables -A INPUT -p tcp --dport 19333 -j ACCEPT

# Überwachung erlauben
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## Support

- GitHub: https://github.com/otedama/otedama
