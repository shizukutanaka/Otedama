# Otedama - Ghid de Utilizare Software Pool de Minerit P2P

## Cuprins
1. [Instalare](#instalare)
2. [Configurare](#configurare)
3. [Rularea Otedama](#rularea-otedama)
4. [Operațiuni de Minerit](#operațiuni-de-minerit)
5. [Gestionarea Pool-ului](#gestionarea-pool-ului)
6. [Monitorizare](#monitorizare)
7. [Depanare](#depanare)

## Instalare

### Cerințe de Sistem
- Sistem de Operare: Linux, Windows, macOS
- RAM: Minim 4GB, Recomandat 8GB+
- Stocare: 50GB+ spațiu liber
- Rețea: Conexiune stabilă la internet

### Instalare Rapidă
```bash
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64
```

## Configurare
Creați `config.yaml` cu algoritm, fire de execuție, URL pool, adresă portofel.

## Rularea Otedama
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet ADRESĂ --worker worker1
```

## Suport
- GitHub: https://github.com/otedama/otedama
