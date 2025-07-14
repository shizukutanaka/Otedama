# Otedama v0.5

**Piattaforma P2P Mining Pool + DEX + DeFi Completamente Automatizzata**

[English](README.md) | [日本語](README.ja.md) | [中文简体](README.zh-CN.md) | [中文繁體](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md) | [Türkçe](README.tr.md) | [Polski](README.pl.md) | [Nederlands](README.nl.md)

---

## Panoramica

Otedama è una piattaforma commerciale di mining pool P2P, DEX e DeFi completamente automatizzata. Costruita seguendo le filosofie di design di John Carmack (prestazioni prima di tutto), Robert C. Martin (architettura pulita) e Rob Pike (semplicità).

### Caratteristiche Principali

- **Operazione Completamente Automatica** - Non richiede intervento manuale
- **Sistema di Commissioni Immutabile** - Raccolta automatica non modificabile dell'1,5% in BTC
- **Supporto Multi-Algoritmo** - Compatibile con CPU/GPU/ASIC
- **DEX Unificato** - V2 AMM + V3 Liquidità Concentrata
- **Pagamento Automatico** - Pagamenti automatici orari delle ricompense ai miner
- **Funzionalità DeFi** - Auto-liquidazione, governance, bridge
- **Livello Enterprise** - Supporta 10.000+ miner

### Caratteristiche di Automazione Operativa

1. **Raccolta Automatica delle Commissioni**
   - Indirizzo BTC: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa (immutabile)
   - Commissione del Pool: 0% (rimossa)
   - Commissione Operativa: 1,5% (non modificabile)
   - Commissione Totale: 1,5% (solo commissione operativa)
   - Frequenza di Raccolta: Ogni 5 minuti
   - Conversione automatica di tutte le valute in BTC

2. **Distribuzione Automatica delle Ricompense di Mining**
   - Esecuzione ogni ora
   - Deduzione automatica delle commissioni del pool
   - Invio automatico al raggiungimento del pagamento minimo
   - Registrazione automatica delle transazioni

3. **DEX/DeFi Completamente Automatizzato**
   - Ribilanciamento automatico dei pool di liquidità
   - Auto-liquidazione (85% LTV)
   - Esecuzione automatica delle proposte di governance
   - Relay automatico dei bridge cross-chain

---

## Requisiti di Sistema

### Requisiti Minimi
- Node.js 18+
- RAM: 2GB
- Storage: 10GB SSD
- Rete: 100Mbps

### Requisiti Consigliati
- CPU: 8+ core
- RAM: 8GB+
- Storage: 100GB NVMe SSD
- Rete: 1Gbps

---

## Installazione

### 1. Installazione Base

```bash
# Clonare il repository
git clone https://github.com/otedama/otedama.git
cd otedama

# Installare le dipendenze
npm install

# Avvio
npm start
```

### 2. Installazione Docker

```bash
# Avvio con Docker Compose
docker-compose up -d

# Verificare i log
docker-compose logs -f otedama
```

### 3. Installazione con Un Clic

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

## Configurazione

### Configurazione Base

Modificare `otedama.json`:

```json
{
  "pool": {
    "name": "Nome del Tuo Pool",
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
    "walletAddress": "Il Tuo Indirizzo Wallet"
  }
}
```

### Configurazione da Linea di Comando

```bash
# Avvio base
node index.js --wallet RYourWalletAddress --currency RVN

# Alte prestazioni
node index.js --threads 16 --max-miners 5000 --enable-dex

# Porte personalizzate
node index.js --api-port 9080 --stratum-port 4444
```

---

## Connessione Miner

### Informazioni di Connessione
- Server: `TUO_IP:3333`
- Nome utente: `IndirizzoWallet.NomeLavoratore`
- Password: `x`

### Esempi di Software di Mining

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://TUO_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://TUO_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o TUO_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Valute Supportate

| Valuta | Algoritmo | Pagamento Min | Commissione |
|--------|-----------|---------------|-------------|
| BTC | SHA256 | 0,001 BTC | 1,5% |
| RVN | KawPow | 100 RVN | 1,5% |
| XMR | RandomX | 0,1 XMR | 1,5% |
| ETC | Ethash | 1 ETC | 1,5% |
| LTC | Scrypt | 0,1 LTC | 1,5% |
| DOGE | Scrypt | 100 DOGE | 1,5% |
| KAS | kHeavyHash | 100 KAS | 1,5% |
| ERGO | Autolykos | 1 ERGO | 1,5% |

Tutte le valute: commissione fissa 1,5% (solo commissione operativa) - non modificabile

---

## API

### Endpoint REST

```bash
# Statistiche del pool
GET /api/stats

# Stato raccolta commissioni
GET /api/fees

# Informazioni miner
GET /api/miners/{minerId}

# Prezzi DEX
GET /api/dex/prices

# Salute del sistema
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

## Informazioni per gli Operatori

### Struttura dei Ricavi

1. **Commissione Operativa**: 1,5% fissa (non modificabile)
2. **Commissione DEX**: 0,3% (distribuita ai fornitori di liquidità)
3. **Commissione DeFi**: Porzione degli interessi sui prestiti

### Attività Automatizzate

- **Ogni 5 minuti**: Conversione e raccolta commissioni operative in BTC
- **Ogni 10 minuti**: Ribilanciamento pool DEX
- **Ogni 30 minuti**: Controllo liquidazione DeFi
- **Ogni ora**: Pagamenti automatici ai miner
- **Ogni 24 ore**: Ottimizzazione database e backup

### Monitoraggio

Dashboard: `http://localhost:8080`

Metriche Chiave:
- Miner attivi
- Hashrate
- Ricavi da commissioni
- Volume DEX
- Risorse di sistema

---

## Sicurezza

### Protezioni Implementate

1. **Protezione DDoS**
   - Limitazione di velocità multilivello
   - Soglie adattive
   - Sfida-risposta

2. **Sistema di Autenticazione**
   - JWT + MFA
   - Controllo accessi basato sui ruoli
   - Gestione chiavi API

3. **Prevenzione Manipolazioni**
   - Indirizzo commissioni operative immutabile
   - Controlli integrità del sistema
   - Log di audit

---

## Risoluzione Problemi

### Porta in Uso
```bash
# Verificare processo che usa la porta
netstat -tulpn | grep :8080

# Terminare processo
kill -9 PID
```

### Problemi di Memoria
```bash
# Aumentare limite memoria Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Modalità Debug
```bash
DEBUG=* node index.js
```

---

## Ottimizzazione Prestazioni

### Funzionalità di Ottimizzazione

- **Elaborazione Database a Batch**: 70% più veloce
- **Ottimizzazione Rete**: Riduzione banda del 40%
- **Caching Avanzato**: Tasso di successo 85%+
- **Operazioni Zero-Copy**: Elaborazione mining efficiente

### Risultati Benchmark

```bash
# Eseguire benchmark
npm run benchmark

# Risultati (8 core, 16GB RAM):
- Database: 50.000+ ops/sec
- Rete: 10.000+ msg/sec
- Tasso successo cache: 85%+
- Uso memoria: <100MB (base)
```

---

## Licenza

Licenza MIT - Uso commerciale consentito

## Supporto

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - Il Futuro del Mining Automatizzato

---