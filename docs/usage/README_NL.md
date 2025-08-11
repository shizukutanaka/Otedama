# Otedama - P2P Mining Pool Software Gebruikershandleiding

## Inhoudsopgave
1. [Installatie](#installatie)
2. [Configuratie](#configuratie)
3. [Otedama Uitvoeren](#otedama-uitvoeren)
4. [Mining Operaties](#mining-operaties)
5. [Pool Beheer](#pool-beheer)
6. [Monitoring](#monitoring)
7. [Probleemoplossing](#probleemoplossing)

## Installatie

### Systeemvereisten
- Besturingssysteem: Linux, Windows, macOS
- RAM: Minimum 4GB, Aanbevolen 8GB+
- Opslag: 50GB+ vrije ruimte
- Netwerk: Stabiele internetverbinding

### Snelle Installatie
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Configuratie
Maak `config.yaml` met algoritme, threads, pool URL, wallet adres.

## Otedama Uitvoeren
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRES --worker worker1
```

## Ondersteuning
- GitHub: https://github.com/otedama/otedama
