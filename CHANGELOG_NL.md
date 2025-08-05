# Wijzigingenlogboek

Alle noemenswaardige wijzigingen aan Otedama worden in dit bestand gedocumenteerd.

Het formaat is gebaseerd op [Keep a Changelog](https://keepachangelog.com/nl/1.0.0/),
en dit project houdt zich aan [Semantisch Versioneren](https://semver.org/lang/nl/).

## [2.1.4] - 2024-01-20

### Toegevoegd
- Enterprise-grade P2P mining pool functionaliteit
- Multi-valuta ondersteuning met PPS/PPLNS beloningsalgoritmen
- Federatieprotocol voor communicatie tussen pools
- Monitoringmogelijkheden op nationaal niveau
- Geavanceerd Stratum v1/v2 protocol met high-performance extensies
- Zero-copy optimalisaties voor verbeterde prestaties
- NUMA-bewuste geheugenallocatie
- Uitgebreide hardwaremonitoring (CPU/GPU/ASIC)
- Real-time WebSocket API voor live updates
- Enterprise beveiligingsfuncties (DDoS-bescherming, snelheidsbeperking)
- Docker/Kubernetes deployment met auto-scaling
- Meertalige ondersteuning (30 talen)

### Gewijzigd
- Architectuur geüpgraded naar microservices met P2P pool ondersteuning
- Mining engine verbeterd met cache-bewuste datastructuren
- Configuratiesysteem verbeterd met validatie
- API bijgewerkt met uitgebreide monitoring endpoints
- Deployment handleidingen gemoderniseerd voor enterprise gebruik

### Opgelost
- Geheugenlekproblemen in mining workers
- Compilatiefouten in crypto en geheugenpakketten
- Cyclische importafhankelijkheden
- Consolidatie van dubbele bestanden in de hele codebase

### Beveiliging
- Uitgebreide DDoS-bescherming toegevoegd
- Enterprise-grade authenticatie geïmplementeerd
- Verbeterde inputvalidatie en -sanitatie
- Beveiligingsauditlogging toegevoegd

## [2.1.3] - 2024-01-15

### Toegevoegd
- Grote code-optimalisatie en opschoning
- Verbeterde foutafhandelingspatronen
- Verbeterd loggingsysteem

### Gewijzigd
- Vereenvoudigde crypto-implementatie
- Geconsolideerde dubbele functionaliteit
- Geoptimaliseerd geheugengebruik

### Opgelost
- Verschillende kleine bugs en problemen

## [2.1.2] - 2024-01-10

### Toegevoegd
- Initiële benchmark suite
- Prestatiemonitoringtools

### Gewijzigd
- Afhankelijkheden bijgewerkt
- Documentatie verbeterd

### Opgelost
- Configuratielaadproblemen

## [2.1.1] - 2024-01-05

### Toegevoegd
- Basis mining functionaliteit
- Initiële API-implementatie

### Gewijzigd
- Projectstructuurverbeteringen

### Opgelost
- Buildsysteemproblemen

## [2.1.0] - 2024-01-01

### Toegevoegd
- Eerste release van Otedama
- Basis CPU mining ondersteuning
- Eenvoudig configuratiesysteem
- REST API endpoints