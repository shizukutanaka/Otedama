# Otedama - P2P Mining Pool Programvara Användarguide

## Innehållsförteckning
1. [Installation](#installation)
2. [Konfiguration](#konfiguration)
3. [Köra Otedama](#köra-otedama)
4. [Mining-operationer](#mining-operationer)
5. [Pool-hantering](#pool-hantering)
6. [Övervakning](#övervakning)
7. [Felsökning](#felsökning)

## Installation

### Systemkrav
- Operativsystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Rekommenderat 8GB+
- Lagring: 50GB+ ledigt utrymme
- Nätverk: Stabil internetanslutning

### Snabbinstallation
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfiguration
Skapa `config.yaml` med algoritm, trådar, pool-URL, plånboksadress.

## Köra Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESS --worker worker1
```

## Support
- GitHub: https://github.com/otedama/otedama
