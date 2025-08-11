# Otedama - Guia de Uso do Software de Pool de Mineração P2P

## Índice
1. [Instalação](#instalação)
2. [Configuração](#configuração)
3. [Executar Otedama](#executar-otedama)
4. [Operações de Mineração](#operações-de-mineração)
5. [Gestão do Pool](#gestão-do-pool)
6. [Monitoramento](#monitoramento)
7. [Solução de Problemas](#solução-de-problemas)

## Instalação

### Requisitos do Sistema
- Sistema Operacional: Linux, Windows, macOS
- RAM: Mínimo 4GB, Recomendado 8GB+
- Armazenamento: 50GB+ espaço livre
- Rede: Conexão estável com a internet

### Instalação Rápida
```bash
# Baixar última versão
wget https://github.com/otedama/releases/latest/otedama-linux-amd64
chmod +x otedama-linux-amd64

# Ou compilar do código fonte
git clone https://github.com/otedama/otedama.git
cd otedama
go build -o otedama cmd/otedama/main.go
```

## Configuração

### Configuração Básica
Criar `config.yaml`:
```yaml
mining:
  algorithm: sha256d
  threads: 4
  intensity: 10

pool:
  url: stratum+tcp://pool.example.com:3333
  wallet_address: SEU_ENDEREÇO_CARTEIRA
  worker_name: worker1

p2p:
  enabled: true
  listen_addr: 0.0.0.0:19333
  max_peers: 50
```

## Executar Otedama

### Mineração Solo
```bash
./otedama --solo --algorithm sha256d --threads 8
```

### Mineração em Pool
```bash
./otedama --pool stratum+tcp://pool.example.com:3333 --wallet SUA_CARTEIRA --worker worker1
```

### Modo Pool P2P
```bash
./otedama --p2p --listen 0.0.0.0:19333 --bootstrap node1.example.com:19333,node2.example.com:19333
```

## Operações de Mineração

### Algoritmos Suportados
- SHA256d (Bitcoin)
- Scrypt (Litecoin)
- Ethash (Ethereum Classic)
- KawPow (Ravencoin)
- RandomX (Monero)
- Autolykos2 (Ergo)

### Otimização de Hardware
```bash
# Mineração CPU com otimização SIMD
./otedama --cpu --optimize simd

# Mineração GPU com múltiplos dispositivos
./otedama --gpu --devices 0,1,2,3

# Mineração ASIC
./otedama --asic --model antminer-s19
```

## Suporte

- GitHub: https://github.com/otedama/otedama
