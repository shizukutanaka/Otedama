# Otedama v0.5

**Plataforma P2P de Mineração + DEX + DeFi Totalmente Automatizada**

### 🌍 Language / Idioma

<details>
<summary><b>Selecione o Idioma (100 idiomas suportados)</b></summary>

[English](README.md) | [Português Brasileiro](README.pt-BR.md) | [Português](README.pt.md) | [Español](README.es.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [Ver todos os idiomas...](README.md#language--言語--语言--idioma--langue--sprache--لغة--भाषा--dil--язык)

</details>

---

## Visão Geral

Otedama é uma plataforma de mineração P2P, DEX e DeFi totalmente automatizada de nível comercial. Construída seguindo as filosofias de design de John Carmack (desempenho primeiro), Robert C. Martin (arquitetura limpa) e Rob Pike (simplicidade).

### Recursos Principais

- **Operação Totalmente Automatizada** - Zero intervenção manual necessária
- **Sistema de Taxa Imutável** - Coleta automática de 0.1% BTC não modificável
- **Suporte Multi-Algoritmo** - Compatível com CPU/GPU/ASIC
- **DEX Unificada** - V2 AMM + V3 Liquidez Concentrada
- **Pagamento Automático** - Pagamentos automáticos de recompensas aos mineradores a cada hora
- **Recursos DeFi** - Auto-liquidação, governança, ponte
- **Nível Empresarial** - Suporta mais de 10.000 mineradores

### Recursos de Automação Operacional

1. **Coleta Automática de Taxas**
   - Endereço BTC: Codificado (imutável)
   - Taxa do pool: 1,4% (não modificável)
   - Taxa operacional: 0,1% (não modificável)
   - Taxa total: 1,5% (totalmente fixa)
   - Frequência de coleta: A cada 5 minutos
   - Conversão automática de todas as moedas para BTC

2. **Distribuição Automática de Recompensas de Mineração**
   - Executa a cada hora
   - Dedução automática de taxas do pool
   - Envio automático quando o pagamento mínimo é atingido
   - Registro automático de transações

3. **DEX/DeFi Totalmente Automatizada**
   - Rebalanceamento automático de pools de liquidez
   - Auto-liquidação (85% LTV)
   - Execução automática de propostas de governança
   - Retransmissão automática de pontes cross-chain

---

## Requisitos do Sistema

### Requisitos Mínimos
- Node.js 18+
- RAM: 2GB
- Armazenamento: 10GB SSD
- Rede: 100Mbps

### Requisitos Recomendados
- CPU: 8+ núcleos
- RAM: 8GB+
- Armazenamento: 100GB NVMe SSD
- Rede: 1Gbps

---

## Instalação

### 1. Instalação Básica

```bash
# Clone o repositório
git clone https://github.com/otedama/otedama.git
cd otedama

# Instale as dependências
npm install

# Inicie
npm start
```

### 2. Instalação Docker

```bash
# Inicie com Docker Compose
docker-compose up -d

# Verifique os logs
docker-compose logs -f otedama
```

### 3. Instalação com Um Clique

**Windows:**
```batch
.\quickstart.bat
```

**Linux/macOS:**
```bash
chmod +x quickstart.sh
./quickstart.sh
```

---

## Configuração

### Configuração Básica

Edite `otedama.json`:

```json
{
  "pool": {
    "name": "Nome do Seu Pool",
    "fee": 1.0,
    "minPayout": {
      "BTC": 0.001,
      "RVN": 100,
      "XMR": 0.1
    }
  },
  "mining": {
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "Seu Endereço de Carteira"
  }
}
```

### Configuração de Linha de Comando

```bash
# Inicialização básica
node index.js --wallet RYourWalletAddress --currency RVN

# Alto desempenho
node index.js --threads 16 --max-miners 5000 --enable-dex

# Portas personalizadas
node index.js --api-port 9080 --stratum-port 4444
```

---

## Conexão de Minerador

### Informações de Conexão
- Servidor: `SEU_IP:3333`
- Nome de usuário: `EndereçoCarteira.NomeTrabalhador`
- Senha: `x`

### Exemplos de Software de Mineração

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://SEU_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://SEU_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o SEU_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## Moedas Suportadas

| Moeda | Algoritmo | Pagamento Mín. | Taxa |
|-------|-----------|----------------|------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

Todas as moedas: taxa fixa de 1,5% (1,4% pool + 0,1% operacional) - não modificável

---

## API

### Endpoints REST

```bash
# Estatísticas do pool
GET /api/stats

# Status de coleta de taxas
GET /api/fees

# Informações do minerador
GET /api/miners/{minerId}

# Preços DEX
GET /api/dex/prices

# Saúde do sistema
GET /health
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['stats', 'mining', 'dex']
}));
```

---

## Informações para Operadores

### Estrutura de Receita

1. **Taxa do Pool**: 1,4% fixa (não modificável)
2. **Taxa Operacional**: 0,1% fixa (não modificável)
3. **Taxa Total de Mineração**: 1,5% (totalmente fixa)
4. **Taxa DEX**: 0,3% (distribuída aos provedores de liquidez)
5. **Taxa DeFi**: Parte dos juros de empréstimo

### Tarefas Automatizadas

- **A cada 5 minutos**: Conversão e coleta de taxa operacional em BTC
- **A cada 10 minutos**: Rebalanceamento de pools DEX
- **A cada 30 minutos**: Verificação de liquidação DeFi
- **A cada hora**: Pagamentos automáticos aos mineradores
- **A cada 24 horas**: Otimização e backup do banco de dados

### Monitoramento

Painel: `http://localhost:8080`

Métricas Principais:
- Mineradores ativos
- Taxa de hash
- Receita de taxas
- Volume DEX
- Recursos do sistema

---

## Segurança

### Proteções Implementadas

1. **Proteção DDoS**
   - Limitação de taxa multicamadas
   - Limites adaptativos
   - Desafio-resposta

2. **Sistema de Autenticação**
   - JWT + MFA
   - Controle de acesso baseado em função
   - Gerenciamento de chaves API

3. **Prevenção de Adulteração**
   - Endereço de taxa operacional imutável
   - Verificações de integridade do sistema
   - Logs de auditoria

---

## Solução de Problemas

### Porta em Uso
```bash
# Verificar processo usando a porta
netstat -tulpn | grep :8080

# Parar processo
kill -9 PID
```

### Problemas de Memória
```bash
# Aumentar limite de memória do Node.js
export NODE_OPTIONS="--max-old-space-size=8192"
```

### Modo Debug
```bash
DEBUG=* node index.js
```

---

## Otimização de Desempenho

### Recursos de Otimização

- **Agrupamento de Banco de Dados**: 70% mais rápido
- **Otimização de Rede**: Redução de 40% na largura de banda
- **Cache Avançado**: Taxa de acerto de 85%+
- **Operações Zero-Copy**: Processamento eficiente de mineração

### Resultados de Benchmark

```bash
# Executar benchmark
npm run benchmark

# Resultados (8 núcleos, 16GB RAM):
- Banco de dados: 50.000+ ops/seg
- Rede: 10.000+ msg/seg
- Taxa de acerto do cache: 85%+
- Uso de memória: <100MB (base)
```

---

## Licença

Licença MIT - Uso comercial permitido

## Suporte

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama v0.5** - O Futuro da Mineração Automatizada

---