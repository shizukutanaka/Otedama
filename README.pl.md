# Otedama v0.5

**W pełni zautomatyzowana platforma P2P Mining Pool + DEX + DeFi**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Przegląd

Otedama to w pełni zautomatyzowana komercyjna platforma P2P mining pool, DEX i DeFi. Zbudowana zgodnie z filozofiami projektowania Johna Carmacka (wydajność przede wszystkim), Roberta C. Martina (czysta architektura) i Roba Pike'a (prostota).

### Główne cechy

- **W pełni automatyczna obsługa** - Nie wymaga ręcznej interwencji
- **Niezmienny system opłat** - Niemodyfikowalny automatyczny pobór 1,5% w BTC
- **Wsparcie wielu algorytmów** - Kompatybilny z CPU/GPU/ASIC
- **Zjednoczony DEX** - V2 AMM + V3 skoncentrowana płynność
- **Automatyczne płatności** - Godzinowe automatyczne wypłaty nagród dla górników
- **Funkcje DeFi** - Auto-likwidacja, zarządzanie, mosty
- **Klasa korporacyjna** - Obsługuje 10 000+ górników

### Funkcje automatyzacji operacyjnej

1. **Automatyczny pobór opłat**
   - Adres BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (niezmienny)
   - Opłata puli: 0% (usunięta)
   - Opłata operacyjna: 1,5% (niemodyfikowalna)
   - Całkowita opłata: 1,5% (tylko opłata operacyjna)
   - Częstotliwość poboru: Co 5 minut
   - Automatyczna konwersja wszystkich walut na BTC

2. **Automatyczna dystrybucja nagród za wydobycie**
   - Wykonywana co godzinę
   - Automatyczne potrącenie opłat puli
   - Automatyczne wysyłanie po osiągnięciu minimalnej wypłaty
   - Automatyczne rejestrowanie transakcji

3. **W pełni zautomatyzowany DEX/DeFi**
   - Automatyczne równoważenie puli płynności
   - Auto-likwidacja (85% LTV)
   - Automatyczne wykonywanie propozycji zarządzania
   - Automatyczne przekazywanie mostów cross-chain

---

## Wymagania systemowe

### Minimalne wymagania
- Node.js 18+
- RAM: 2GB
- Pamięć: 10GB SSD
- Sieć: 100Mbps

### Zalecane wymagania
- CPU: 8+ rdzeni
- RAM: 8GB+
- Pamięć: 100GB NVMe SSD
- Sieć: 1Gbps

---

## Instalacja

### 1. Podstawowa instalacja

```bash
# Sklonuj repozytorium
git clone https://github.com/otedama/otedama.git
cd otedama

# Zainstaluj zależności
npm install

# Uruchom
npm start
```

### 2. Instalacja Docker

```bash
# Uruchom z Docker Compose
docker-compose up -d

# Sprawdź logi
docker-compose logs -f otedama
```

### 3. Instalacja jednym kliknięciem

**Windows:**
```batch
.\quickstart.bat
```

**Linux/macOS:**
```bash
chmod +x quickstart.sh
./quickstart.sh
```

---

## Konfiguracja

### Podstawowa konfiguracja

Edytuj `otedama.json`:

```json
{
  "pool": {
    "name": "Nazwa Twojej Puli",
    "fee": 1.0,
    "minPayout": {
      "BTC": 0.001,
      "RVN": 100,
      "XMR": 0.1
    }
  },
  "mining": {
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "Twój Adres Portfela"
  }
}
```

### Konfiguracja z linii poleceń

```bash
# Podstawowe uruchomienie
node index.js --wallet RYourWalletAddress --currency RVN

# Wysoka wydajność
node index.js --threads 16 --max-miners 5000 --enable-dex

# Niestandardowe porty
node index.js --api-port 9080 --stratum-port 4444
```

---

## Połączenie górników

### Informacje o połączeniu
- Serwer: `TWÓJ_IP:3333`
- Nazwa użytkownika: `AdresPortfela.NazwaPracownika`
- Hasło: `x`

### Przykłady oprogramowania górniczego

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://TWÓJ_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://TWÓJ_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o TWÓJ_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Obsługiwane waluty

| Waluta | Algorytm | Min. wypłata | Opłata |
|--------|----------|--------------|--------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Wszystkie waluty: stała opłata 1,5% (tylko opłata operacyjna) - niemodyfikowalna

---

## API

### Punkty końcowe REST

```bash
# Statystyki puli
GET /api/stats

# Status poboru opłat
GET /api/fees

# Informacje o górniku
GET /api/miners/{minerId}

# Ceny DEX
GET /api/dex/prices

# Zdrowie systemu
GET /health
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['stats', 'mining', 'dex']
}));
```

---

## Informacje dla operatorów

### Struktura przychodów

1. **Opłata operacyjna**: 1,5% stała (niemodyfikowalna)
2. **Opłata DEX**: 0,3% (dystrybuowana do dostawców płynności)
3. **Opłata DeFi**: Część odsetek od pożyczek

### Zautomatyzowane zadania

- **Co 5 minut**: Konwersja i pobór opłat operacyjnych w BTC
- **Co 10 minut**: Równoważenie puli DEX
- **Co 30 minut**: Sprawdzanie likwidacji DeFi
- **Co godzinę**: Automatyczne płatności dla górników
- **Co 24 godziny**: Optymalizacja bazy danych i kopia zapasowa

### Monitorowanie

Panel kontrolny: `http://localhost:8080`

Kluczowe metryki:
- Aktywni górnicy
- Hashrate
- Przychody z opłat
- Wolumen DEX
- Zasoby systemowe

---

## Bezpieczeństwo

### Wdrożone zabezpieczenia

1. **Ochrona przed DDoS**
   - Wielopoziomowe ograniczanie szybkości
   - Adaptacyjne progi
   - Wyzwanie-odpowiedź

2. **System uwierzytelniania**
   - JWT + MFA
   - Kontrola dostępu oparta na rolach
   - Zarządzanie kluczami API

3. **Zapobieganie manipulacjom**
   - Niezmienny adres opłat operacyjnych
   - Kontrole integralności systemu
   - Dzienniki audytu

---

## Rozwiązywanie problemów

### Port w użyciu
```bash
# Sprawdź proces używający portu
netstat -tulpn | grep :8080

# Zatrzymaj proces
kill -9 PID
```

### Problemy z pamięcią
```bash
# Zwiększ limit pamięci Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Tryb debugowania
```bash
DEBUG=* node index.js
```

---

## Optymalizacja wydajności

### Funkcje optymalizacji

- **Przetwarzanie wsadowe bazy danych**: 70% szybciej
- **Optymalizacja sieci**: Redukcja przepustowości o 40%
- **Zaawansowane buforowanie**: Współczynnik trafień 85%+
- **Operacje bez kopiowania**: Wydajne przetwarzanie wydobycia

### Wyniki testów wydajności

```bash
# Uruchom test wydajności
npm run benchmark

# Wyniki (8 rdzeni, 16GB RAM):
- Baza danych: 50 000+ ops/sek
- Sieć: 10 000+ wiad/sek
- Współczynnik trafień cache: 85%+
- Użycie pamięci: <100MB (podstawowe)
```

---

## Licencja

Licencja MIT - Dozwolone użycie komercyjne

## Wsparcie

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Przyszłość zautomatyzowanego wydobycia

---