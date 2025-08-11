# Otedama - Przewodnik Użytkownika Oprogramowania P2P Mining Pool

## Spis Treści
1. [Instalacja](#instalacja)
2. [Konfiguracja](#konfiguracja)
3. [Uruchamianie Otedama](#uruchamianie-otedama)
4. [Operacje Wydobywcze](#operacje-wydobywcze)
5. [Zarządzanie Poolem](#zarządzanie-poolem)
6. [Monitorowanie](#monitorowanie)
7. [Rozwiązywanie Problemów](#rozwiązywanie-problemów)

## Instalacja

### Wymagania Systemowe
- System Operacyjny: Linux, Windows, macOS
- RAM: Minimum 4GB, Zalecane 8GB+
- Pamięć: 50GB+ wolnego miejsca
- Sieć: Stabilne połączenie internetowe

### Szybka Instalacja
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Konfiguracja
Utwórz `config.yaml` z algorytmem, wątkami, URL pool, adresem portfela.

## Uruchamianie Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRES --worker worker1
```

## Wsparcie
- GitHub: https://github.com/otedama/otedama
