# Otedama - P2P Mining Pool Programvare Brukerveiledning

## Innholdsfortegnelse
1. [Installasjon](#installasjon)
2. [Konfigurasjon](#konfigurasjon)
3. [Kjøre Otedama](#kjøre-otedama)
4. [Mining-operasjoner](#mining-operasjoner)
5. [Pool-administrasjon](#pool-administrasjon)
6. [Overvåking](#overvåking)
7. [Feilsøking](#feilsøking)

## Installasjon

### Systemkrav
- Operativsystem: Linux, Windows, macOS
- RAM: Minimum 4GB, Anbefalt 8GB+
- Lagring: 50GB+ ledig plass
- Nettverk: Stabil internettforbindelse

### Rask Installasjon
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurasjon
Opprett `config.yaml` med algoritme, tråder, pool-URL, lommebokadresse.

## Kjøre Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESSE --worker worker1
```

## Støtte
- GitHub: https://github.com/otedama/otedama
