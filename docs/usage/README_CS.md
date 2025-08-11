# Otedama - Uživatelská Příručka P2P Mining Pool Software

## Obsah
1. [Instalace](#instalace)
2. [Konfigurace](#konfigurace)
3. [Spuštění Otedama](#spuštění-otedama)
4. [Těžební Operace](#těžební-operace)
5. [Správa Poolu](#správa-poolu)
6. [Monitorování](#monitorování)
7. [Řešení Problémů](#řešení-problémů)

## Instalace

### Systémové Požadavky
- Operační systém: Linux, Windows, macOS
- RAM: Minimum 4GB, Doporučeno 8GB+
- Úložiště: 50GB+ volného místa
- Síť: Stabilní internetové připojení

### Rychlá Instalace
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfigurace
Vytvořte `config.yaml` s algoritmem, vlákny, URL poolu, adresou peněženky.

## Spuštění Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESA --worker worker1
```

## Podpora
- GitHub: https://github.com/otedama/otedama
