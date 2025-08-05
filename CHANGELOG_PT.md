# Registro de alterações

Todas as mudanças notáveis do Otedama serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [2.1.4] - 2025-08-20

### Adicionado
- Funcionalidade de pool de mineração P2P de nível empresarial
- Suporte multi-moeda com algoritmos de recompensa PPS/PPLNS
- Protocolo de federação para comunicação entre pools
- Capacidades de monitoramento em nível nacional
- Protocolo Stratum v1/v2 avançado com extensões de alto desempenho
- Otimizações zero-copy para melhor desempenho
- Alocação de memória consciente de NUMA
- Monitoramento abrangente de hardware (CPU/GPU/ASIC)
- API WebSocket em tempo real para atualizações ao vivo
- Recursos de segurança empresarial (proteção DDoS, limitação de taxa)
- Implantação Docker/Kubernetes com escalonamento automático
- Suporte multilíngue (30 idiomas)

### Alterado
- Arquitetura atualizada para microsserviços com suporte a pool P2P
- Motor de mineração aprimorado com estruturas de dados conscientes de cache
- Sistema de configuração melhorado com validação
- API atualizada com endpoints de monitoramento abrangentes
- Guias de implantação modernizados para uso empresarial

### Corrigido
- Problemas de vazamento de memória em workers de mineração
- Erros de compilação em pacotes de criptografia e memória
- Dependências cíclicas de importação
- Consolidação de arquivos duplicados em toda a base de código

### Segurança
- Proteção DDoS abrangente adicionada
- Autenticação de nível empresarial implementada
- Validação e sanitização de entrada aprimoradas
- Log de auditoria de segurança adicionado

## [2.1.3] - 2025-08-15

### Adicionado
- Otimização e limpeza importantes do código
- Padrões de tratamento de erros melhorados
- Sistema de log aprimorado

### Alterado
- Implementação criptográfica simplificada
- Funcionalidade duplicada consolidada
- Uso de memória otimizado

### Corrigido
- Vários bugs menores e problemas

## [2.1.2] - 2025-08-10

### Adicionado
- Suíte de benchmark inicial
- Ferramentas de monitoramento de desempenho

### Alterado
- Dependências atualizadas
- Documentação melhorada

### Corrigido
- Problemas de carregamento de configuração

## [2.1.1] - 2025-08-05

### Adicionado
- Funcionalidade básica de mineração
- Implementação inicial da API

### Alterado
- Melhorias na estrutura do projeto

### Corrigido
- Problemas do sistema de compilação

## [2.1.0] - 2025-08-01

### Adicionado
- Lançamento inicial do Otedama
- Suporte básico para mineração CPU
- Sistema de configuração simples
- Endpoints da API REST