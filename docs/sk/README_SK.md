# Otedama - Podnikový P2P Ťažobný Pool a Ťažobný Softvér

**Licencia**: MIT  
**Go Verzia**: 1.21+  
**Architektúra**: Mikroslužby s podporou P2P poolu  

Otedama je podnikový P2P ťažobný pool a ťažobný softvér navrhnutý pre maximálnu efektívnosť a spoľahlivosť. Postavený podľa princípov dizajnu Johna Carmacka (výkon), Roberta C. Martina (čistá architektúra) a Roba Pikea (jednoduchosť), podporuje komplexnú ťažbu CPU/GPU/ASIC s národnou škálovateľnosťou.

## Architektúra

### P2P Ťažobný Pool
- **Distribuovaná Správa Poolu**: Distribuovaný ťažobný pool s automatickým prepnutím pri zlyhaní
- **Distribúcia Odmien**: Pokročilé algoritmy PPS/PPLNS s podporou viacerých mien
- **Federačný Protokol**: Komunikácia medzi poolmi pre zvýšenú odolnosť
- **Monitorovanie na Národnej Úrovni**: Podnikové monitorovanie vhodné pre vládne nasadenia

### Ťažobné Funkcie
- **Multi-Algoritmus**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Univerzálny Hardvér**: Optimalizované pre CPU, GPU (CUDA/OpenCL), ASIC
- **Pokročilé Stratum**: Plná podpora v1/v2 s rozšíreniami pre vysoko výkonných ťažiarov
- **Zero-Copy Optimalizácie**: Cache-aware dátové štruktúry a NUMA-aware pamäť

### Podnikové Funkcie
- **Pripravené na Produkciu**: Docker/Kubernetes nasadenie s automatickým škálovaním
- **Podniková Bezpečnosť**: DDoS ochrana, obmedzenie rýchlosti, komplexný audit
- **Vysoká Dostupnosť**: Multi-node nastavenie s automatickým prepnutím pri zlyhaní
- **Real-time Analytika**: WebSocket API s integráciou živého dashboardu

## Požiadavky

- Go 1.21 alebo vyššia
- Linux, macOS, Windows
- Ťažobný hardvér (CPU/GPU/ASIC)
- Sieťové pripojenie k ťažobnému poolu

## Inštalácia

### Zo zdrojového kódu

```bash
# Zostavenie v zdrojovom adresári
cd Otedama

# Zostavenie binárneho súboru
make build

# Inštalácia do systému
make install
```

### Použitie Go Build

```bash
go build ./cmd/otedama
```

### Docker Produkcia

```bash
# Produkčné nasadenie
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Nasadenie celého stacku
kubectl apply -f k8s/
```

## Rýchly Štart

### 1. Konfigurácia

```yaml
# Produkčná konfigurácia s podporou P2P poolu
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Automatická detekcia
    priority: "normal"
  
  gpu:
    devices: [] # Automatická detekcia všetkých zariadení
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Automatické objavenie
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

### 2. Možnosti Nasadenia

```bash
# Vývoj
./otedama serve --config config.yaml

# Produkčný Docker
docker-compose -f docker-compose.production.yml up -d

# Podnikový Kubernetes
kubectl apply -f k8s/

# Manuálne produkčné nasadenie
sudo ./scripts/production-deploy.sh
```

### 3. Monitorovanie Výkonu

```bash
# Kontrola stavu
./otedama status

# Zobrazenie logov
tail -f logs/otedama.log

# API endpoint
curl http://localhost:8080/api/status
```

## Výkon

Otedama je optimalizovaná pre maximálnu efektívnosť:

- **Využitie Pamäte**: Optimalizované pre minimálnu pamäťovú stopu
- **Veľkosť Binárneho Súboru**: Kompaktná veľkosť (~15MB)
- **Čas Spustenia**: <500ms
- **CPU Réžia**: <1% pre monitorovanie

## API Referencia

### REST Endpointy

- `GET /api/status` - Stav ťažby
- `GET /api/stats` - Detailné štatistiky
- `GET /api/workers` - Informácie o pracovníkoch
- `POST /api/mining/start` - Spustiť ťažbu
- `POST /api/mining/stop` - Zastaviť ťažbu

### WebSocket

Pripojte sa k `ws://localhost:8080/api/ws` pre real-time aktualizácie.

## Nasadenie

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

## Prispievanie

Príspevky sú vítané! Dodržujte prosím štandardné vývojové postupy:

1. Vytvorte feature branch
2. Vykonajte zmeny
3. Dôkladne otestujte
4. Odošlite na kontrolu

## Licencia

Tento projekt je licencovaný pod licenciou MIT - pozrite súbor [LICENSE](LICENSE) pre detaily.

## Poďakovanie

- Vývojári Bitcoin Core za ťažobné protokoly
- Go komunita za vynikajúce knižnice
- Všetci prispievatelia a používatelia Otedama

## Podpora

- Skontrolujte dokumentáciu v adresári `docs/`
- Prezrite si príklady konfigurácie v `config.example.yaml`
- Konzultujte API dokumentáciu na `/api/docs` počas behu

## Dary

Ak považujete Otedama za užitočnú, zvážte podporu vývoja:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Vaša podpora pomáha udržiavať a vylepšovať Otedama!

---

**⚠️ Dôležité**: Ťažba kryptomien spotrebúva významné výpočtové zdroje a elektrinu. Pred začatím ťažby prosím pochopte náklady a dopad na životné prostredie.