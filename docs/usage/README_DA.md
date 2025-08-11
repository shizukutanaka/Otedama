# Otedama - P2P Mining Pool Software Brugervejledning

## Indholdsfortegnelse
1. [Installation](#installation)
2. [Konfiguration](#konfiguration)
3. [Kør Otedama](#kør-otedama)
4. [Mining-operationer](#mining-operationer)
5. [Pool-administration](#pool-administration)
6. [Overvågning](#overvågning)
7. [Fejlfinding](#fejlfinding)

## Installation

### Systemkrav
- Operativsystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Anbefalet 8GB+
- Lagerplads: 50GB+ ledig plads
- Netværk: Stabil internetforbindelse

### Hurtig Installation
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfiguration
Opret `config.yaml` med algoritme, tråde, pool-URL, tegnebogsadresse.

## Kør Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESSE --worker worker1
```

## Support
- GitHub: https://github.com/otedama/otedama
