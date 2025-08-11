# Otedama - P2P Louhintapoolin Ohjelmisto Käyttöopas

## Sisällysluettelo
1. [Asennus](#asennus)
2. [Konfigurointi](#konfigurointi)
3. [Otedaman Käynnistys](#otedaman-käynnistys)
4. [Louhintaoperaatiot](#louhintaoperaatiot)
5. [Poolin Hallinta](#poolin-hallinta)
6. [Valvonta](#valvonta)
7. [Vianmääritys](#vianmääritys)

## Asennus

### Järjestelmävaatimukset
- Käyttöjärjestelmä: Linux, Windows, macOS
- RAM: Vähintään 4GB, Suositus 8GB+
- Tallennustila: 50GB+ vapaata tilaa
- Verkko: Vakaa internetyhteys

### Pika-asennus
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurointi
Luo `config.yaml` algoritmilla, säikeillä, pool-URL:lla, lompakko-osoitteella.

## Otedaman Käynnistys
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet OSOITE --worker worker1
```

## Tuki
- GitHub: https://github.com/otedama/otedama
