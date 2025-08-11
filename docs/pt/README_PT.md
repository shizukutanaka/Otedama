# Otedama - Pool de Mineração P2P e Software de Mineração Empresarial

**Versão**: 2.1.6  
**Licença**: MIT  
**Versão Go**: 1.21+  
**Arquitetura**: Microsserviços com suporte a pool P2P  
**Data de lançamento**: 6 de agosto de 2025

Otedama é um pool de mineração P2P e software de mineração de nível empresarial projetado para máxima eficiência e confiabilidade. Construído seguindo os princípios de design de John Carmack (performance), Robert C. Martin (arquitetura limpa) e Rob Pike (simplicidade), suporta mineração abrangente CPU/GPU/ASIC com escalabilidade nacional.

## Arquitetura

### Pool de Mineração P2P
- **Gerenciamento de Pool Distribuído**: Pool de mineração distribuído com failover automático
- **Distribuição de Recompensas**: Algoritmos PPS/PPLNS avançados com suporte multi-moeda
- **Protocolo de Federação**: Comunicação entre pools para maior resistência
- **Monitoramento Nacional**: Monitoramento empresarial adequado para implantações governamentais

### Recursos de Mineração
- **Multi-Algoritmo**: SHA256d, Ethash, RandomX, Scrypt, KawPow
- **Hardware Universal**: Otimizado para CPU, GPU (CUDA/OpenCL), ASIC
- **Stratum Avançado**: Suporte completo v1/v2 com extensões para mineradores de alto desempenho
- **Otimizações Zero-Copy**: Estruturas de dados cache-aware e memória NUMA-aware

### Recursos Empresariais
- **Pronto para Produção**: Implantação Docker/Kubernetes com auto-scaling
- **Segurança Empresarial**: Proteção DDoS, limitação de taxa, auditoria abrangente
- **Alta Disponibilidade**: Configuração multi-nó com failover automático
- **Análise em Tempo Real**: API WebSocket com integração de dashboard ao vivo

## Requisitos

- Go 1.21 ou superior
- Linux, macOS, Windows
- Hardware de mineração (CPU/GPU/ASIC)
- Conexão de rede ao pool de mineração

## Instalação

### A partir do código fonte

```bash
# Construir no diretório fonte
cd Otedama

# Construir binário
make build

# Instalar no sistema
make install
```

### Usar Go Build

```bash
go build ./cmd/otedama
```

### Docker Produção

```bash
# Implantação de produção
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# Implantar stack completo
kubectl apply -f k8s/
```

## Início Rápido

### 1. Configuração

```yaml
# Configuração de produção com suporte a pool P2P
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # Auto-detecção
    priority: "normal"
  
  gpu:
    devices: [] # Detectar automaticamente todos os dispositivos
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # Auto-descoberta
    poll_interval: 5s

pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 10000
  fee_percentage: 1.0
  rewards:
    system: "PPLNS"
    window: 2h

api:
  enable: true
  address: "0.0.0.0:8080"
  auth:
    enabled: true
    token_expiry: 24h

monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
  health:
    enabled: true
    address: "0.0.0.0:8081"
```

### 2. Opções de Implantação

```bash
# Desenvolvimento
./otedama serve --config config.yaml

# Docker de Produção
docker-compose -f docker-compose.production.yml up -d

# Kubernetes Empresarial
kubectl apply -f k8s/

# Implantação manual de produção
sudo ./scripts/production-deploy.sh
```

### 3. Monitoramento de Performance

```bash
# Verificar status
./otedama status

# Ver logs
tail -f logs/otedama.log

# Endpoint API
curl http://localhost:8080/api/status
```

## Performance

Otedama é otimizado para máxima eficiência:

- **Uso de Memória**: Otimizado para pegada mínima de memória
- **Tamanho Binário**: Tamanho compacto (~15MB)
- **Tempo de Inicialização**: <500ms
- **Overhead CPU**: <1% para monitoramento

## Referência da API

### Endpoints REST

- `GET /api/status` - Status de mineração
- `GET /api/stats` - Estatísticas detalhadas
- `GET /api/workers` - Informações dos trabalhadores
- `POST /api/mining/start` - Iniciar mineração
- `POST /api/mining/stop` - Parar mineração

### WebSocket

Conectar a `ws://localhost:8080/api/ws` para atualizações em tempo real.

## Implantação

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    build: .
    volumes:
      - ./config.yaml:/config.yaml
    ports:
      - "8080:8080"
      - "3333:3333"
    restart: unless-stopped
```

### Kubernetes

```bash
kubectl apply -f k8s/
```

## Contribuição

Contribuições são bem-vindas! Siga as práticas padrão de desenvolvimento:

1. Criar branch de feature
2. Fazer alterações
3. Testar minuciosamente
4. Submeter para revisão

## Licença

Este projeto está licenciado sob a Licença MIT - ver o arquivo [LICENSE](LICENSE) para detalhes.

## Agradecimentos

- Desenvolvedores do Bitcoin Core por protocolos de mineração
- Comunidade Go por excelentes bibliotecas
- Todos os contribuidores e usuários do Otedama

## Suporte

- Verificar documentação no diretório `docs/`
- Revisar exemplos de configuração em `config.example.yaml`
- Consultar documentação da API em `/api/docs` durante execução

## Doações

Se você acha o Otedama útil, considere apoiar o desenvolvimento:

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

Seu apoio ajuda a manter e melhorar o Otedama!

---

**⚠️ Importante**: A mineração de criptomoedas consome recursos computacionais e eletricidade significativos. Por favor, compreenda os custos e impacto ambiental antes de iniciar a mineração.