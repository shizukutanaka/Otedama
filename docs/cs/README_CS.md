# Otedama - Podnikový P2P Těžební Pool a Těžební Software

**Licence**: MIT  
**Verze Go**: 1.21+  
**Architektura**: Mikroslužby s podporou P2P poolu  

Otedama je podnikový P2P těžební pool a těžební software navržený pro maximální efektivitu a spolehlivost. Postavený podle principů designu Johna Carmacka (výkon), Roberta C. Martina (čistá architektura) a Roba Pikea (jednoduchost), podporuje komplexní těžbu CPU/GPU/ASIC s národní škálovatelností.

## Architektura

### P2P Těžební Pool
- **Distribuovaná Správa Poolu**: Distribuovaný těžební pool s automatickým převzetím při selhání
- **Distribuce Odměn**: Pokročilé algoritmy PPS/PPLNS s podporou více měn
- **Federační Protokol**: Komunikace mezi pooly pro zvýšenou odolnost
- **Monitorování na Národní Úrovni**: Podnikové monitorování vhodné pro vládní nasazení

### Těžební Funkce
- **Multi-Algoritmus**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Univerzální Hardware**: Optimalizováno pro CPU, GPU (CUDA/OpenCL), ASIC
- **Pokročilé Stratum**: Plná podpora v1/v2 s rozšířeními pro vysoce výkonné těžaře
- **Zero-Copy Optimalizace**: Cache-aware datové struktury a NUMA-aware paměť

### Podnikové Funkce
- **Připraveno na Produkci**: Docker/Kubernetes nasazení s automatickým škálováním
- **Podniková Bezpečnost**: DDoS ochrana, omezení rychlosti, komplexní audit
- **Vysoká Dostupnost**: Multi-node nastavení s automatickým převzetím při selhání
- **Real-time Analytika**: WebSocket API s integrací živého dashboardu

## Požadavky

- Go 1.21 nebo vyšší
- Linux, macOS, Windows
- Těžební hardware (CPU/GPU/ASIC)
- Síťové připojení k těžebnímu poolu

## Instalace

### Ze zdrojového kódu

```bash
# Sestavení ve zdrojovém adresáři
cd Otedama

# Sestavení binárního souboru
make build

# Instalace do systému
make install
```

### Použití Go Build

```bash
go build ./cmd/otedama
```

### Docker Produkce

```bash
# Produkční nasazení
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Nasazení celého stacku
kubectl apply -f k8s/
```

## Rychlý Start

### 1. Konfigurace

```yaml
# Produkční konfigurace s podporou P2P poolu
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Automatická detekce
    priority: "normal"
  
  gpu:
    devices: [] # Automatická detekce všech zařízení
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Automatické objevení
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

### 2. Možnosti Nasazení

```bash
# Vývoj
./otedama serve --config config.yaml

# Produkční Docker
docker-compose -f docker-compose.production.yml up -d

# Podnikový Kubernetes
kubectl apply -f k8s/

# Manuální produkční nasazení
sudo ./scripts/production-deploy.sh
```

### 3. Monitorování Výkonu

```bash
# Kontrola stavu
./otedama status

# Zobrazení logů
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Výkon

Otedama je optimalizována pro maximální efektivitu:

- **Využití Paměti**: Optimalizováno pro minimální paměťovou stopu
- **Velikost Binárního Souboru**: Kompaktní velikost (~15MB)
- **Čas Spuštění**: <500ms
- **CPU Režie**: <1% pro monitorování

## API Reference

### REST Endpointy

- `GET /api/status` - Stav těžby
- `GET /api/stats` - Detailní statistiky
- `GET /api/workers` - Informace o pracovnících
- `POST /api/mining/start` - Spustit těžbu
- `POST /api/mining/stop` - Zastavit těžbu

### WebSocket

Připojte se k `ws://localhost:8080/api/ws` pro real-time aktualizace.

## Nasazení

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

## Přispívání

Příspěvky jsou vítány! Dodržujte prosím standardní vývojové postupy:

1. Vytvořte feature branch
2. Proveďte změny
3. Důkladně otestujte
4. Odešlete k revizi

## Licence

Tento projekt je licencován pod licencí MIT - viz soubor [LICENSE](LICENSE) pro detaily.

## Poděkování

- Vývojáři Bitcoin Core za těžební protokoly
- Go komunita za vynikající knihovny
- Všichni přispěvatelé a uživatelé Otedama

## Podpora

- Zkontrolujte dokumentaci v adresáři `docs/`
- Prohlédněte si příklady konfigurace v `config.example.yaml`
- Konzultujte API dokumentaci na `/api/docs` během běhu

## Dary

Pokud považujete Otedama za užitečnou, zvažte podporu vývoje:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Vaše podpora pomáhá udržovat a vylepšovat Otedama!

---

**⚠️ Důležité**: Těžba kryptoměn spotřebovává významné výpočetní zdroje a elektřinu. Před zahájením těžby prosím pochopte náklady a dopad na životní prostředí.