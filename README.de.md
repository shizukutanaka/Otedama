# Otedama v0.5

**Vollautomatische P2P Mining-Pool + DEX + DeFi Plattform**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Übersicht

Otedama ist eine vollautomatische kommerzielle P2P-Mining-Pool-, DEX- und DeFi-Plattform. Entwickelt nach den Design-Philosophien von John Carmack (Leistung zuerst), Robert C. Martin (saubere Architektur) und Rob Pike (Einfachheit).

### Hauptmerkmale

- **Vollautomatischer Betrieb** - Kein manueller Eingriff erforderlich
- **Unveränderliches Gebührensystem** - Nicht modifizierbarer automatischer 1,5% BTC-Einzug
- **Multi-Algorithmus-Unterstützung** - CPU/GPU/ASIC kompatibel
- **Einheitlicher DEX** - V2 AMM + V3 konzentrierte Liquidität
- **Automatische Zahlungen** - Stündliche automatische Miner-Belohnungszahlungen
- **DeFi-Funktionen** - Auto-Liquidation, Governance, Bridges
- **Enterprise-Klasse** - Unterstützt 10.000+ Miner

### Operative Automatisierungsfunktionen

1. **Automatischer Gebühreneinzug**
   - BTC-Adresse: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (unveränderlich)
   - Pool-Gebühr: 0% (entfernt)
   - Betriebsgebühr: 1,5% (nicht modifizierbar)
   - Gesamtgebühr: 1,5% (nur Betriebsgebühr)
   - Einzugsfrequenz: Alle 5 Minuten
   - Automatische Umwandlung aller Währungen in BTC

2. **Automatische Mining-Belohnungsverteilung**
   - Stündliche Ausführung
   - Automatischer Pool-Gebührenabzug
   - Automatisches Senden bei Erreichen der Mindestauszahlung
   - Automatische Transaktionsaufzeichnung

3. **Vollautomatisierter DEX/DeFi**
   - Automatisches Rebalancing von Liquiditätspools
   - Auto-Liquidation (85% LTV)
   - Automatische Ausführung von Governance-Vorschlägen
   - Automatisches Relais von Cross-Chain-Bridges

---

## Systemanforderungen

### Mindestanforderungen
- Node.js 18+
- RAM: 2GB
- Speicher: 10GB SSD
- Netzwerk: 100Mbps

### Empfohlene Anforderungen
- CPU: 8+ Kerne
- RAM: 8GB+
- Speicher: 100GB NVMe SSD
- Netzwerk: 1Gbps

---

## Installation

### 1. Grundinstallation

```bash
# Repository klonen
git clone https://github.com/otedama/otedama.git
cd otedama

# Abhängigkeiten installieren
npm install

# Start
npm start
```

### 2. Docker-Installation

```bash
# Mit Docker Compose starten
docker-compose up -d

# Logs überprüfen
docker-compose logs -f otedama
```

### 3. Ein-Klick-Installation

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

## Konfiguration

### Grundkonfiguration

`otedama.json` bearbeiten:

```json
{
  "pool": {
    "name": "Ihr Pool-Name",
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
    "walletAddress": "Ihre Wallet-Adresse"
  }
}
```

### Befehlszeilenkonfiguration

```bash
# Grundstart
node index.js --wallet RYourWalletAddress --currency RVN

# Hohe Leistung
node index.js --threads 16 --max-miners 5000 --enable-dex

# Benutzerdefinierte Ports
node index.js --api-port 9080 --stratum-port 4444
```

---

## Miner-Verbindung

### Verbindungsinformationen
- Server: `IHRE_IP:3333`
- Benutzername: `WalletAdresse.WorkerName`
- Passwort: `x`

### Mining-Software-Beispiele

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://IHRE_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://IHRE_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o IHRE_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Unterstützte Währungen

| Währung | Algorithmus | Min. Auszahlung | Gebühr |
|---------|-------------|-----------------|---------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Alle Währungen: 1,5% Festgebühr (nur Betriebsgebühr) - nicht modifizierbar

---

## API

### REST-Endpunkte

```bash
# Pool-Statistiken
GET /api/stats

# Gebühreneinzugsstatus
GET /api/fees

# Miner-Informationen
GET /api/miners/{minerId}

# DEX-Preise
GET /api/dex/prices

# Systemzustand
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

## Betreiber-Informationen

### Einnahmestruktur

1. **Betriebsgebühr**: 1,5% fest (nicht modifizierbar)
2. **DEX-Gebühr**: 0,3% (an Liquiditätsanbieter verteilt)
3. **DeFi-Gebühr**: Teil der Kreditzinsen

### Automatisierte Aufgaben

- **Alle 5 Minuten**: Betriebsgebühren BTC-Umwandlung und -Einzug
- **Alle 10 Minuten**: DEX-Pool-Rebalancing
- **Alle 30 Minuten**: DeFi-Liquidationsprüfung
- **Stündlich**: Automatische Miner-Zahlungen
- **Alle 24 Stunden**: Datenbankoptimierung und Backup

### Überwachung

Dashboard: `http://localhost:8080`

Schlüsselmetriken:
- Aktive Miner
- Hashrate
- Gebühreneinnahmen
- DEX-Volumen
- Systemressourcen

---

## Sicherheit

### Implementierte Schutzmaßnahmen

1. **DDoS-Schutz**
   - Mehrstufige Ratenbegrenzung
   - Adaptive Schwellenwerte
   - Challenge-Response

2. **Authentifizierungssystem**
   - JWT + MFA
   - Rollenbasierte Zugriffskontrolle
   - API-Schlüsselverwaltung

3. **Manipulationsschutz**
   - Unveränderliche Betreibergebührenadresse
   - Systemintegritätsprüfungen
   - Audit-Protokolle

---

## Fehlerbehebung

### Port in Verwendung
```bash
# Prozess überprüfen, der den Port verwendet
netstat -tulpn | grep :8080

# Prozess beenden
kill -9 PID
```

### Speicherprobleme
```bash
# Node.js-Speicherlimit erhöhen
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Debug-Modus
```bash
DEBUG=* node index.js
```

---

## Leistungsoptimierung

### Optimierungsfunktionen

- **Datenbank-Stapelverarbeitung**: 70% schneller
- **Netzwerkoptimierung**: 40% Bandbreitenreduzierung
- **Erweitertes Caching**: 85%+ Trefferquote
- **Zero-Copy-Operationen**: Effiziente Mining-Verarbeitung

### Benchmark-Ergebnisse

```bash
# Benchmark ausführen
npm run benchmark

# Ergebnisse (8 Kerne, 16GB RAM):
- Datenbank: 50.000+ ops/Sek
- Netzwerk: 10.000+ msg/Sek
- Cache-Trefferquote: 85%+
- Speichernutzung: <100MB (Basis)
```

---

## Lizenz

MIT-Lizenz - Kommerzielle Nutzung erlaubt

## Support

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Die Zukunft des automatisierten Minings

---