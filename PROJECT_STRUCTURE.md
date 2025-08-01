# Otedama Project Structure

## 📁 Directory Overview

```
Otedama/
├── 📂 cmd/                    # Command-line applications
│   ├── benchmark/             # Benchmarking tool
│   └── otedama/              # Main application entry point
│
├── 📂 internal/              # Private application code (30 modules)
│   ├── 🔧 Core Systems
│   │   ├── core/             # Main system orchestration
│   │   ├── app/              # Application layer
│   │   └── config/           # Configuration management
│   │
│   ├── ⛏️ Mining & Blockchain
│   │   ├── mining/           # Mining engines & algorithms (16 algos)
│   │   ├── consensus/        # Consensus mechanisms
│   │   ├── stratum/          # Mining protocol
│   │   ├── pool/             # Mining pool management
│   │   └── p2p/              # Peer-to-peer networking
│   │
│   ├── 🔒 Security & Privacy
│   │   ├── security/         # Multi-layered security (9 components)
│   │   ├── zkp/              # Zero-knowledge proofs (8 systems)
│   │   └── privacy/          # Privacy management
│   │
│   ├── 📊 Operations & Monitoring
│   │   ├── monitoring/       # System monitoring (11 components)
│   │   ├── logging/          # Centralized logging (5 types)
│   │   ├── api/              # REST API endpoints
│   │   └── dashboard/        # Web management interface
│   │
│   ├── ⚡ Performance & Storage
│   │   ├── optimization/     # Performance optimizers (16 types)
│   │   ├── cache/            # Multi-tier caching
│   │   └── storage/          # Storage management
│   │
│   └── 🏢 Enterprise Features
│       ├── automation/       # Self-healing automation (6 components)
│       ├── deployment/       # CI/CD pipeline
│       ├── backup/           # Disaster recovery
│       └── testing/          # Chaos engineering
│
├── 📂 config/                # Configuration files
│   ├── nginx.conf           # Nginx configuration
│   └── prometheus.yml       # Prometheus monitoring config
│
├── 📂 tests/                 # Integration & E2E tests
│   ├── integration/         # Integration test suites
│   └── e2e/                 # End-to-end tests
│
├── 📂 scripts/               # Deployment & utility scripts
│   ├── build.sh             # Build automation
│   ├── deploy.sh            # Deployment scripts
│   └── install_deps.sh      # Dependency installation
│
├── 📂 agents/                # AI agent configurations
│   └── test-specialist.md   # Test automation agent
│
├── 📂 data/                  # Runtime data
│   └── otedama.db           # SQLite database
│
├── 📂 logs/                  # Application logs
└── 📂 docs/                  # Documentation (to be populated)

## 🏗️ Architecture Patterns

### Layered Architecture
```
API Layer → Application Layer → Core Layer → Infrastructure Layer
```

### Key Design Principles
- **Interface-Driven Design**: All major components expose interfaces
- **Separation of Concerns**: Clear module boundaries
- **Dependency Injection**: Loose coupling between components
- **Plugin Architecture**: Extensible mining algorithms

## 📊 Module Statistics

| Category | Modules | Files | Description |
|----------|---------|-------|-------------|
| Core Infrastructure | 3 | 15 | System core, app layer, config |
| Mining & Blockchain | 5 | 45 | Mining, consensus, networking |
| Security & Privacy | 3 | 23 | Security layers, ZKP, privacy |
| Operations | 4 | 35 | Monitoring, logging, APIs |
| Performance | 3 | 28 | Optimization, caching, storage |
| Enterprise | 4 | 20 | Automation, deployment, testing |

## 🔧 Key Components

### Mining Algorithms (16 types)
- RandomX, SHA256, Ethash, Blake2b
- CuckooCycle, Equihash, Lyra2REv3
- X16R, Groestl, Keccak, Skein
- NeoScrypt, Qubit, Yescrypt, Argon2d, Custom

### Security Layers (9 components)
- Encryptor, Firewall, IDS, Rate Limiter
- Security Manager, WAF, Multi-layer defense
- ZKP systems for privacy

### Monitoring Stack (11 components)
- Prometheus integration
- Performance monitoring
- Health checks & alerts
- Real-time dashboards

## 🚀 Entry Points

1. **Main Application**: `/cmd/otedama/main.go`
2. **Benchmark Tool**: `/cmd/benchmark/main.go`

## 📝 Configuration

- **config.yaml**: Main application configuration
- **nginx.conf**: Web server configuration
- **prometheus.yml**: Monitoring configuration

## 🧪 Testing

- **Unit Tests**: Distributed across internal packages
- **Integration Tests**: `/tests/integration/`
- **E2E Tests**: `/tests/e2e/`
- **Test Coverage**: ~9% by file count (14 test files / 154 total)

## 🔄 Build & Deploy

- **Build**: `./scripts/build.sh`
- **Deploy**: `./scripts/deploy.sh`
- **Dependencies**: `./scripts/install_deps.sh`

## 📈 Recommendations

1. **Consolidate duplicate functionality** in monitoring and stratum
2. **Standardize naming conventions** across all modules
3. **Move version.go** to `/internal/version/`
4. **Populate /docs/** with architecture documentation
5. **Increase test coverage** to industry standard (>80%)