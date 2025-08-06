# Otedama - Vállalati P2P Bányászmedence és Bányászszoftver

**Licenc**: MIT  
**Go Verzió**: 1.21+  
**Architektúra**: Mikroszolgáltatások P2P medence támogatással  

Az Otedama egy vállalati szintű P2P bányászmedence és bányászszoftver, amelyet maximális hatékonyságra és megbízhatóságra terveztek. John Carmack (teljesítmény), Robert C. Martin (tiszta architektúra) és Rob Pike (egyszerűség) tervezési elvei alapján épült, átfogó CPU/GPU/ASIC bányászatot támogat nemzeti szintű skálázhatósággal.

## Architektúra

### P2P Bányászmedence
- **Elosztott Medence Kezelés**: Elosztott bányászmedence automatikus átkapcsolással
- **Jutalom Elosztás**: Fejlett PPS/PPLNS algoritmusok többvalutás támogatással
- **Föderációs Protokoll**: Medencék közötti kommunikáció a fokozott rugalmasság érdekében
- **Nemzeti Szintű Megfigyelés**: Vállalati megfigyelés kormányzati telepítésekhez

### Bányászati Funkciók
- **Multi-Algoritmus**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Univerzális Hardver**: Optimalizálva CPU-ra, GPU-ra (CUDA/OpenCL), ASIC-ra
- **Fejlett Stratum**: Teljes v1/v2 támogatás kiterjesztésekkel nagy teljesítményű bányászokhoz
- **Zero-Copy Optimalizációk**: Cache-tudatos adatstruktúrák és NUMA-tudatos memória

### Vállalati Funkciók
- **Termelésre Kész**: Docker/Kubernetes telepítés automatikus skálázással
- **Vállalati Biztonság**: DDoS védelem, sebességkorlátozás, átfogó auditálás
- **Magas Rendelkezésre Állás**: Több csomópontos beállítás automatikus átkapcsolással
- **Valós Idejű Analitika**: WebSocket API élő műszerfal integrációval

## Követelmények

- Go 1.21 vagy újabb
- Linux, macOS, Windows
- Bányász hardver (CPU/GPU/ASIC)
- Hálózati kapcsolat a bányászmedencéhez

## Telepítés

### Forráskódból

```bash
# Építés a forrás könyvtárban
cd Otedama

# Bináris építése
make build

# Telepítés a rendszerbe
make install
```

### Go Build Használata

```bash
go build ./cmd/otedama
```

### Docker Termelés

```bash
# Termelési telepítés
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Teljes stack telepítése
kubectl apply -f k8s/
```

## Gyors Kezdés

### 1. Konfiguráció

```yaml
# Termelési konfiguráció P2P medence támogatással
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Automatikus észlelés
    priority: "normal"
  
  gpu:
    devices: [] # Minden eszköz automatikus észlelése
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Automatikus felfedezés
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

### 2. Telepítési Opciók

```bash
# Fejlesztés
./otedama serve --config config.yaml

# Termelési Docker
docker-compose -f docker-compose.production.yml up -d

# Vállalati Kubernetes
kubectl apply -f k8s/

# Kézi termelési telepítés
sudo ./scripts/production-deploy.sh
```

### 3. Teljesítmény Megfigyelés

```bash
# Állapot ellenőrzése
./otedama status

# Naplók megtekintése
tail -f logs/otedama.log

# API végpont
curl http://localhost:8080/api/status
```

## Teljesítmény

Az Otedama maximális hatékonyságra van optimalizálva:

- **Memória Használat**: Minimális memória lábnyomra optimalizálva
- **Bináris Méret**: Kompakt méret (~15MB)
- **Indítási Idő**: <500ms
- **CPU Többletterhelés**: <1% megfigyeléshez

## API Referencia

### REST Végpontok

- `GET /api/status` - Bányászat állapota
- `GET /api/stats` - Részletes statisztikák
- `GET /api/workers` - Munkás információk
- `POST /api/mining/start` - Bányászat indítása
- `POST /api/mining/stop` - Bányászat leállítása

### WebSocket

Csatlakozzon a `ws://localhost:8080/api/ws` címhez valós idejű frissítésekért.

## Telepítés

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

## Hozzájárulás

A hozzájárulásokat szívesen fogadjuk! Kérjük, kövesse a standard fejlesztési gyakorlatokat:

1. Hozzon létre funkció ágat
2. Végezze el a változtatásokat
3. Alaposan tesztelje
4. Küldje be felülvizsgálatra

## Licenc

Ez a projekt MIT licenc alatt van licencelve - lásd a [LICENSE](LICENSE) fájlt a részletekért.

## Köszönetnyilvánítás

- Bitcoin Core fejlesztők a bányászati protokollokért
- Go közösség a kiváló könyvtárakért
- Az Otedama összes közreműködője és felhasználója

## Támogatás

- Ellenőrizze a dokumentációt a `docs/` könyvtárban
- Tekintse át a konfigurációs példákat a `config.example.yaml` fájlban
- Konzultáljon az API dokumentációval a `/api/docs` címen futás közben

## Adományok

Ha hasznosnak találja az Otedamát, fontolja meg a fejlesztés támogatását:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Az Ön támogatása segít az Otedama karbantartásában és fejlesztésében!

---

**⚠️ Fontos**: A kriptovaluta bányászat jelentős számítási erőforrásokat és elektromos áramot fogyaszt. Kérjük, értse meg a költségeket és a környezeti hatásokat a bányászat megkezdése előtt.