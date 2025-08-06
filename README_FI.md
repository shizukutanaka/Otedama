# Otedama - Yritystason P2P Kaivospooli ja Kaivosohjelma

**Lisenssi**: MIT  
**Go Versio**: 1.21+  
**Arkkitehtuuri**: Mikropalvelut P2P pool tuella  

Otedama on yritystason P2P kaivospooli ja kaivosohjelma, joka on suunniteltu maksimaalista tehokkuutta ja luotettavuutta varten. Rakennettu John Carmackin (suorituskyky), Robert C. Martinin (puhdas arkkitehtuuri) ja Rob Piken (yksinkertaisuus) suunnitteluperiaatteiden mukaisesti, se tukee kattavaa CPU/GPU/ASIC louhintaa kansallisen tason skaalautuvuudella.

## Arkkitehtuuri

### P2P Kaivospooli
- **Hajautettu Poolin Hallinta**: Hajautettu kaivospooli automaattisella varakytkennällä
- **Palkkioiden Jakelu**: Edistyneet PPS/PPLNS algoritmit monivaluuttatuella
- **Federaatioprotokolla**: Pool-välinen viestintä parannetun sietokyvyn saavuttamiseksi
- **Kansallisen Tason Valvonta**: Yritysvalvonta sopii valtion käyttöönotoille

### Louhintaominaisuudet
- **Monialgoritmi**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Universaali Laitteisto**: Optimoitu CPU:lle, GPU:lle (CUDA/OpenCL), ASIC:ille
- **Edistynyt Stratum**: Täysi v1/v2 tuki laajennuksilla korkean suorituskyvyn louhijoille
- **Zero-Copy Optimoinnit**: Välimuistitietoiset tietorakenteet ja NUMA-tietoinen muisti

### Yritysominaisuudet
- **Tuotantovalmis**: Docker/Kubernetes käyttöönotto automaattisella skaalauksella
- **Yritysturvallisuus**: DDoS-suojaus, nopeusrajoitus, kattava auditointi
- **Korkea Saatavuus**: Monisolmuasennus automaattisella varakytkennällä
- **Reaaliaikainen Analytiikka**: WebSocket API live-kojelaudan integraatiolla

## Vaatimukset

- Go 1.21 tai uudempi
- Linux, macOS, Windows
- Louhintalaitteisto (CPU/GPU/ASIC)
- Verkkoyhteys kaivospooliin

## Asennus

### Lähdekoodista

```bash
# Rakenna lähdekoodihakemistossa
cd Otedama

# Rakenna binääri
make build

# Asenna järjestelmään
make install
```

### Käytä Go Buildia

```bash
go build ./cmd/otedama
```

### Docker Tuotanto

```bash
# Tuotantokäyttöönotto
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Ota käyttöön koko pino
kubectl apply -f k8s/
```

## Pikakäynnistys

### 1. Konfiguraatio

```yaml
# Tuotantokonfiguraatio P2P pool tuella
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Automaattinen tunnistus
    priority: "normal"
  
  gpu:
    devices: [] # Tunnista kaikki laitteet automaattisesti
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Automaattinen löytäminen
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

### 2. Käyttöönottovaihtoehdot

```bash
# Kehitys
./otedama serve --config config.yaml

# Tuotanto Docker
docker-compose -f docker-compose.production.yml up -d

# Yritys Kubernetes
kubectl apply -f k8s/

# Manuaalinen tuotantokäyttöönotto
sudo ./scripts/production-deploy.sh
```

### 3. Suorituskyvyn Valvonta

```bash
# Tarkista tila
./otedama status

# Näytä lokit
tail -f logs/otedama.log

# API päätepiste
curl http://localhost:8080/api/status
```

## Suorituskyky

Otedama on optimoitu maksimaalista tehokkuutta varten:

- **Muistin Käyttö**: Optimoitu minimaaliselle muistijalanjäljelle
- **Binäärikoko**: Kompakti koko (~15MB)
- **Käynnistysaika**: <500ms
- **CPU Yleiskustannus**: <1% valvonnalle

## API Viite

### REST Päätepisteet

- `GET /api/status` - Louhinnan tila
- `GET /api/stats` - Yksityiskohtaiset tilastot
- `GET /api/workers` - Työntekijätiedot
- `POST /api/mining/start` - Aloita louhinta
- `POST /api/mining/stop` - Lopeta louhinta

### WebSocket

Yhdistä `ws://localhost:8080/api/ws` reaaliaikaisille päivityksille.

## Käyttöönotto

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

## Osallistuminen

Osallistumiset ovat tervetulleita! Noudata vakiokehityskäytäntöjä:

1. Luo ominaisuushaara
2. Tee muutokset
3. Testaa perusteellisesti
4. Lähetä tarkastettavaksi

## Lisenssi

Tämä projekti on lisensoitu MIT-lisenssillä - katso [LICENSE](LICENSE) tiedosto yksityiskohtia varten.

## Kiitokset

- Bitcoin Core kehittäjät louhintaprotokollista
- Go yhteisö erinomaisista kirjastoista
- Kaikki Otedaman osallistujat ja käyttäjät

## Tuki

- Tarkista dokumentaatio `docs/` hakemistosta
- Tarkastele konfiguraatioesimerkkejä `config.example.yaml` tiedostossa
- Konsultoi API-dokumentaatiota `/api/docs` käytön aikana

## Lahjoitukset

Jos pidät Otedamaa hyödyllisenä, harkitse kehityksen tukemista:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Tukesi auttaa ylläpitämään ja parantamaan Otedamaa!

---

**⚠️ Tärkeää**: Kryptovaluuttojen louhinta kuluttaa merkittäviä laskentaresursseja ja sähköä. Ole hyvä ja ymmärrä kustannukset ja ympäristövaikutukset ennen louhinnan aloittamista.