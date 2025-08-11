# Otedama - Korporacyjny P2P Pool Wydobywczy i Oprogramowanie Wydobywcze

**Wersja**: 2.1.6  
**Licencja**: MIT  
**Wersja Go**: 1.21+  
**Architektura**: Mikroserwisy ze wsparciem puli P2P  
**Data wydania**: 6 sierpnia 2025

Otedama to korporacyjny P2P pool wydobywczy i oprogramowanie wydobywcze zaprojektowane dla maksymalnej efektywności i niezawodności. Zbudowane zgodnie z zasadami projektowania John Carmack (wydajność), Robert C. Martin (czysta architektura) i Rob Pike (prostota), wspiera kompleksowe wydobywanie CPU/GPU/ASIC ze skalowalnością na poziomie krajowym.

## Architektura

### P2P Pool Wydobywczy
- **Rozproszone Zarządzanie Poolem**: Rozproszony pool wydobywczy z automatyczną awariją
- **Dystrybucja Nagród**: Zaawansowane algorytmy PPS/PPLNS z obsługą wielu walut
- **Protokół Federacji**: Komunikacja między poolami dla zwiększonej odporności
- **Monitoring Krajowy**: Monitoring korporacyjny odpowiedni dla wdrożeń rządowych

### Funkcje Wydobywcze
- **Multi-Algorytm**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Uniwersalny Sprzęt**: Zoptymalizowany dla CPU, GPU (CUDA/OpenCL), ASIC
- **Zaawansowany Stratum**: Pełna obsługa v1/v2 z rozszerzeniami dla minerów wysokiej wydajności
- **Optymalizacje Zero-Copy**: Struktury danych świadome cache i pamięć świadoma NUMA

### Funkcje Korporacyjne
- **Gotowy do Produkcji**: Wdrożenie Docker/Kubernetes z auto-skalowaniem
- **Bezpieczeństwo Korporacyjne**: Ochrona DDoS, ograniczanie szybkości, kompleksowy audyt
- **Wysoka Dostępność**: Konfiguracja wielowęzłowa z automatyczną awarią
- **Analityka Czasu Rzeczywistego**: API WebSocket z integracją dashboardu na żywo

## Wymagania

- Go 1.21 lub wyższy
- Linux, macOS, Windows
- Sprzęt wydobywczy (CPU/GPU/ASIC)
- Połączenie sieciowe do puli wydobywczej

## Instalacja

### Ze źródeł

```bash
# Budowanie w katalogu źródłowym
cd Otedama

# Budowanie pliku binarnego
make build

# Instalacja w systemie
make install
```

### Używanie Go Build

```bash
go build ./cmd/otedama
```

### Docker Produkcja

```bash
# Wdrożenie produkcyjne
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Wdrożenie pełnego stosu
kubectl apply -f k8s/
```

## Szybki Start

### 1. Konfiguracja

```yaml
# Konfiguracja produkcyjna z obsługą puli P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-wykrywanie
    priority: "normal"
  
  gpu:
    devices: [] # Automatyczne wykrywanie wszystkich urządzeń
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-odkrywanie
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

### 2. Opcje Wdrożenia

```bash
# Rozwój
./otedama serve --config config.yaml

# Docker Produkcyjny
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Korporacyjny
kubectl apply -f k8s/

# Ręczne wdrożenie produkcyjne
sudo ./scripts/production-deploy.sh
```

### 3. Monitoring Wydajności

```bash
# Sprawdzenie statusu
./otedama status

# Przeglądanie logów
tail -f logs/otedama.log

# Endpoint API
curl http://localhost:8080/api/status
```

## Wydajność

Otedama jest zoptymalizowane dla maksymalnej efektywności:

- **Użycie Pamięci**: Zoptymalizowane dla minimalnego śladu pamięciowego
- **Rozmiar Pliku Binarnego**: Kompaktowy rozmiar (~15MB)
- **Czas Uruchomienia**: <500ms
- **Narzut CPU**: <1% dla monitoringu

## Referencje API

### Endpointy REST

- `GET /api/status` - Status wydobywania
- `GET /api/stats` - Szczegółowe statystyki
- `GET /api/workers` - Informacje o pracownikach
- `POST /api/mining/start` - Rozpoczęcie wydobywania
- `POST /api/mining/stop` - Zatrzymanie wydobywania

### WebSocket

Połącz się z `ws://localhost:8080/api/ws` dla aktualizacji czasu rzeczywistego.

## Wdrożenie

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

## Wkład

Wkłady są mile widziane! Proszę przestrzegać standardowych praktyk rozwojowych:

1. Utwórz gałąź funkcji
2. Wprowadź zmiany
3. Testuj dokładnie
4. Prześlij do przeglądu

## Licencja

Ten projekt jest licencjonowany na podstawie Licencji MIT - zobacz plik [LICENSE](LICENSE) dla szczegółów.

## Podziękowania

- Deweloperzy Bitcoin Core za protokoły wydobywcze
- Społeczność Go za doskonałe biblioteki
- Wszyscy współtwórcy i użytkownicy Otedama

## Wsparcie

- Sprawdź dokumentację w katalogu `docs/`
- Przejrzyj przykłady konfiguracji w `config.example.yaml`
- Skonsultuj się z dokumentacją API pod adresem `/api/docs` podczas działania

## Darowizny

Jeśli uważasz Otedama za przydatne, rozważ wsparcie rozwoju:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Twoje wsparcie pomaga w utrzymaniu i ulepszaniu Otedama!

---

**⚠️ Ważne**: Wydobywanie kryptowalut zużywa znaczące zasoby obliczeniowe i elektryczność. Proszę zrozumieć koszty i wpływ środowiskowy przed rozpoczęciem wydobywania.