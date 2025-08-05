# Registro delle modifiche

Tutte le modifiche rilevanti di Otedama saranno documentate in questo file.

Il formato è basato su [Keep a Changelog](https://keepachangelog.com/it-IT/1.0.0/),
e questo progetto aderisce al [Versionamento Semantico](https://semver.org/lang/it/).

## [2.1.4] - 2025-08-20

### Aggiunto
- Funzionalità di pool di mining P2P di livello enterprise
- Supporto multi-valuta con algoritmi di ricompensa PPS/PPLNS
- Protocollo di federazione per la comunicazione tra pool
- Capacità di monitoraggio a livello nazionale
- Protocollo Stratum v1/v2 avanzato con estensioni ad alte prestazioni
- Ottimizzazioni zero-copy per prestazioni migliorate
- Allocazione memoria consapevole di NUMA
- Monitoraggio hardware completo (CPU/GPU/ASIC)
- API WebSocket in tempo reale per aggiornamenti live
- Funzionalità di sicurezza enterprise (protezione DDoS, limitazione velocità)
- Deployment Docker/Kubernetes con auto-scaling
- Supporto multilingue (30 lingue)

### Modificato
- Architettura aggiornata a microservizi con supporto pool P2P
- Motore di mining migliorato con strutture dati consapevoli della cache
- Sistema di configurazione migliorato con validazione
- API aggiornata con endpoint di monitoraggio completi
- Guide di deployment modernizzate per uso aziendale

### Risolto
- Problemi di perdita di memoria nei worker di mining
- Errori di compilazione nei pacchetti crypto e memoria
- Dipendenze cicliche di importazione
- Consolidamento file duplicati in tutta la codebase

### Sicurezza
- Aggiunta protezione DDoS completa
- Implementata autenticazione di livello enterprise
- Migliorata validazione e sanificazione input
- Aggiunto logging di audit di sicurezza

## [2.1.3] - 2025-08-15

### Aggiunto
- Ottimizzazione e pulizia maggiore del codice
- Pattern di gestione errori migliorati
- Sistema di logging migliorato

### Modificato
- Implementazione crittografica semplificata
- Funzionalità duplicate consolidate
- Utilizzo memoria ottimizzato

### Risolto
- Vari bug minori e problemi

## [2.1.2] - 2025-08-10

### Aggiunto
- Suite di benchmark iniziale
- Strumenti di monitoraggio prestazioni

### Modificato
- Dipendenze aggiornate
- Documentazione migliorata

### Risolto
- Problemi di caricamento configurazione

## [2.1.1] - 2025-08-05

### Aggiunto
- Funzionalità di mining di base
- Implementazione API iniziale

### Modificato
- Miglioramenti struttura progetto

### Risolto
- Problemi sistema di build

## [2.1.0] - 2025-08-01

### Aggiunto
- Rilascio iniziale di Otedama
- Supporto mining CPU di base
- Sistema di configurazione semplice
- Endpoint API REST