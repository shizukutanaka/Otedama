# Otedama - Guida all'Uso del Software Pool di Mining P2P

## Indice
1. [Installazione](#installazione)
2. [Configurazione](#configurazione)
3. [Eseguire Otedama](#eseguire-otedama)
4. [Operazioni di Mining](#operazioni-di-mining)
5. [Gestione Pool](#gestione-pool)
6. [Monitoraggio](#monitoraggio)
7. [Risoluzione Problemi](#risoluzione-problemi)

## Installazione

### Requisiti di Sistema
- Sistema Operativo: Linux, Windows, macOS
- RAM: Minimo 4GB, Consigliato 8GB+
- Storage: 50GB+ spazio libero
- Rete: Connessione internet stabile

### Installazione Rapida
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Configurazione
Creare `config.yaml` con algoritmo, threads, pool URL, indirizzo wallet.

## Eseguire Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet INDIRIZZO --worker worker1
```

## Supporto
- GitHub: https://github.com/otedama/otedama
