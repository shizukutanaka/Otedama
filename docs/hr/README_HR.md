# Otedama - Korporativni P2P Mining Pool i Mining Softver

**Licenca**: MIT  
**Go Verzija**: 1.21+  
**Arhitektura**: Mikroservisi s podrškom za P2P pool  

Otedama je korporativni P2P mining pool i mining softver dizajniran za maksimalnu učinkovitost i pouzdanost. Izgrađen prema principima dizajna Johna Carmacka (performanse), Roberta C. Martina (čista arhitektura) i Roba Pikea (jednostavnost), podržava sveobuhvatan CPU/GPU/ASIC mining s nacionalnom skalabilnošću.

## Arhitektura

### P2P Mining Pool
- **Distribuirano Upravljanje Poolom**: Distribuirani mining pool s automatskim prebacivanjem u slučaju kvara
- **Distribucija Nagrada**: Napredni PPS/PPLNS algoritmi s podrškom za više valuta
- **Federacijski Protokol**: Komunikacija između poolova za poboljšanu otpornost
- **Nadzor na Nacionalnoj Razini**: Korporativni nadzor prikladan za vladina postavljanja

### Mining Značajke
- **Multi-Algoritam**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Univerzalni Hardver**: Optimizirano za CPU, GPU (CUDA/OpenCL), ASIC
- **Napredni Stratum**: Potpuna v1/v2 podrška s ekstenzijama za visoko performansne rudare
- **Zero-Copy Optimizacije**: Cache-svjesne strukture podataka i NUMA-svjesna memorija

### Korporativne Značajke
- **Spreman za Produkciju**: Docker/Kubernetes postavljanje s automatskim skaliranjem
- **Korporativna Sigurnost**: DDoS zaštita, ograničavanje brzine, sveobuhvatna revizija
- **Visoka Dostupnost**: Multi-node postavka s automatskim prebacivanjem u slučaju kvara
- **Analitika u Stvarnom Vremenu**: WebSocket API s integracijom nadzorne ploče uživo

## Zahtjevi

- Go 1.21 ili noviji
- Linux, macOS, Windows
- Mining hardver (CPU/GPU/ASIC)
- Mrežna veza s mining poolom

## Instalacija

### Iz izvornog koda

```bash
# Izgradnja u direktoriju izvora
cd Otedama

# Izgradnja binarne datoteke
make build

# Instalacija u sustav
make install
```

### Korištenje Go Build

```bash
go build ./cmd/otedama
```

### Docker Produkcija

```bash
# Produkcijsko postavljanje
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Postavljanje cijelog stoga
kubectl apply -f k8s/
```

## Brzi Početak

### 1. Konfiguracija

```yaml
# Produkcijska konfiguracija s podrškom za P2P pool
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Automatska detekcija
    priority: "normal"
  
  gpu:
    devices: [] # Automatska detekcija svih uređaja
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Automatsko otkrivanje
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

### 2. Opcije Postavljanja

```bash
# Razvoj
./otedama serve --config config.yaml

# Produkcijski Docker
docker-compose -f docker-compose.production.yml up -d

# Korporativni Kubernetes
kubectl apply -f k8s/

# Ručno produkcijsko postavljanje
sudo ./scripts/production-deploy.sh
```

### 3. Nadzor Performansi

```bash
# Provjera statusa
./otedama status

# Pregled zapisa
tail -f logs/otedama.log

# API krajnja točka
curl http://localhost:8080/api/status
```

## Performanse

Otedama je optimizirana za maksimalnu učinkovitost:

- **Korištenje Memorije**: Optimizirano za minimalni memorijski otisak
- **Veličina Binarne Datoteke**: Kompaktna veličina (~15MB)
- **Vrijeme Pokretanja**: <500ms
- **CPU Opterećenje**: <1% za nadzor

## API Referenca

### REST Krajnje Točke

- `GET /api/status` - Status mininga
- `GET /api/stats` - Detaljne statistike
- `GET /api/workers` - Informacije o radnicima
- `POST /api/mining/start` - Pokreni mining
- `POST /api/mining/stop` - Zaustavi mining

### WebSocket

Povežite se na `ws://localhost:8080/api/ws` za ažuriranja u stvarnom vremenu.

## Postavljanje

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

## Doprinosi

Doprinosi su dobrodošli! Molimo slijedite standardne razvojne prakse:

1. Napravite feature granu
2. Napravite promjene
3. Temeljito testirajte
4. Pošaljite na pregled

## Licenca

Ovaj projekt je licenciran pod MIT licencom - pogledajte [LICENSE](LICENSE) datoteku za detalje.

## Zahvale

- Bitcoin Core razvijatelji za protokole mininga
- Go zajednica za izvrsne biblioteke
- Svi doprinosi i korisnici Otedame

## Podrška

- Provjerite dokumentaciju u direktoriju `docs/`
- Pregledajte primjere konfiguracije u `config.example.yaml`
- Konzultirajte API dokumentaciju na `/api/docs` tijekom rada

## Donacije

Ako smatrate Otedamu korisnom, razmislite o podršci razvoju:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Vaša podrška pomaže održavanju i poboljšanju Otedame!

---

**⚠️ Važno**: Mining kriptovaluta troši značajne računalne resurse i električnu energiju. Molimo razumite troškove i utjecaj na okoliš prije početka mininga.