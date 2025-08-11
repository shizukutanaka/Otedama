# Development Guide

## 🛠️ Development Environment Setup

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.21+ | Primary language |
| PostgreSQL | 14+ | Main database |
| Redis | 7+ | Caching layer |
| Docker | 20.10+ | Containerization |
| Git | 2.30+ | Version control |

### Optional Tools

| Tool | Purpose |
|------|---------|
| Kubernetes | Container orchestration |
| Prometheus | Metrics collection |
| Grafana | Metrics visualization |
| VS Code / GoLand | IDE |

## 🏃 Quick Start

### 1. Clone and Setup

```bash
# Clone repository
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# Install dependencies
go mod download

# Copy configuration
cp config/config.example.yaml config/config.yaml
```

### 2. Start Dependencies

```bash
# Using Docker Compose (recommended)
docker-compose up -d postgres redis

# Or manually
docker run -d --name otedama-postgres \
  -e POSTGRES_PASSWORD=otedama \
  -e POSTGRES_USER=otedama \
  -e POSTGRES_DB=otedama \
  -p 5432:5432 \
  postgres:14

docker run -d --name otedama-redis \
  -p 6379:6379 \
  redis:7-alpine
```

### 3. Initialize Database

```bash
# Run migrations
go run cmd/migrate/main.go up

# Seed development data (optional)
go run cmd/migrate/main.go seed
```

### 4. Run Application

```bash
# Development mode with hot reload
go run cmd/otedama/main.go --config config/config.yaml --dev

# Or build and run
go build -o otedama cmd/otedama/main.go
./otedama --config config/config.yaml
```

## 📁 Project Structure

See [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) for detailed directory layout.

### Key Directories

- `cmd/` - Application entry points
- `internal/` - Private application code
- `config/` - Configuration files
- `scripts/` - Utility scripts
- `docs/` - Documentation
- `test/` - Integration tests

## 🔧 Development Workflow

### 1. Feature Development

```bash
# Create feature branch
git checkout -b feature/your-feature-name

# Make changes
# ... edit files ...

# Run tests
go test ./...

# Commit changes
git add .
git commit -m "feat: add new feature"

# Push to fork
git push origin feature/your-feature-name
```

### 2. Code Standards

#### Go Code Style

```go
// Package comment describes the package
package mining

import (
    "context"
    "fmt"
    
    "github.com/shizukutanaka/otedama/internal/common"
)

// Engine represents the mining engine.
// It manages workers and coordinates mining operations.
type Engine struct {
    workers []Worker
    config  Config
    mu      sync.RWMutex
}

// NewEngine creates a new mining engine with the given configuration.
func NewEngine(cfg Config) (*Engine, error) {
    if err := cfg.Validate(); err != nil {
        return nil, fmt.Errorf("invalid config: %w", err)
    }
    
    return &Engine{
        config:  cfg,
        workers: make([]Worker, 0, cfg.MaxWorkers),
    }, nil
}

// Start begins mining operations.
func (e *Engine) Start(ctx context.Context) error {
    e.mu.Lock()
    defer e.mu.Unlock()
    
    // Implementation
    return nil
}
```

#### Error Handling

```go
// Always wrap errors with context
if err := operation(); err != nil {
    return fmt.Errorf("failed to perform operation: %w", err)
}

// Use custom errors for specific cases
var (
    ErrInvalidShare = errors.New("invalid share submitted")
    ErrPoolFull     = errors.New("mining pool is full")
)
```

### 3. Testing

#### Unit Tests

```go
func TestEngine_Start(t *testing.T) {
    tests := []struct {
        name    string
        config  Config
        wantErr bool
    }{
        {
            name:    "valid config",
            config:  validConfig(),
            wantErr: false,
        },
        {
            name:    "invalid config",
            config:  Config{},
            wantErr: true,
        },
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            engine, err := NewEngine(tt.config)
            if tt.wantErr {
                require.Error(t, err)
                return
            }
            require.NoError(t, err)
            
            ctx := context.Background()
            err = engine.Start(ctx)
            require.NoError(t, err)
        })
    }
}
```

#### Benchmarks

```go
func BenchmarkHashCalculation(b *testing.B) {
    data := []byte("test data for hashing")
    b.ResetTimer()
    
    for i := 0; i < b.N; i++ {
        _ = calculateHash(data)
    }
}
```

### 4. Debugging

#### Enable Debug Logging

```yaml
# config/config.yaml
logging:
  level: debug
  format: json
  output: stdout
```

#### Use Delve Debugger

```bash
# Install delve
go install github.com/go-delve/delve/cmd/dlv@latest

# Debug application
dlv debug cmd/otedama/main.go -- --config config/config.yaml

# Set breakpoint
(dlv) break main.main
(dlv) continue
```

## 🔍 Code Quality

### Linting

```bash
# Install golangci-lint
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s latest

# Run linter
golangci-lint run ./...
```

### Format Code

```bash
# Format all Go files
go fmt ./...

# Use goimports for import organization
goimports -w .
```

### Security Scanning

```bash
# Install gosec
go install github.com/securego/gosec/v2/cmd/gosec@latest

# Run security scan
gosec ./...
```

## 📊 Performance Profiling

### CPU Profiling

```go
import _ "net/http/pprof"

func main() {
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()
    // ... rest of application
}
```

```bash
# Capture CPU profile
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Analyze profile
(pprof) top10
(pprof) web
```

### Memory Profiling

```bash
# Capture memory profile
go tool pprof http://localhost:6060/debug/pprof/heap

# Analyze allocations
(pprof) alloc_objects
(pprof) inuse_objects
```

## 🐳 Docker Development

### Build Image

```bash
# Development image
docker build -t otedama:dev .

# Production image
docker build -f Dockerfile.production -t otedama:latest .
```

### Run Container

```bash
# Run with local config
docker run -v $(pwd)/config:/app/config \
  -p 8080:8080 \
  otedama:dev
```

## 🔄 Git Workflow

### Branch Strategy

- `main` - Production-ready code
- `develop` - Development branch
- `feature/*` - New features
- `fix/*` - Bug fixes
- `docs/*` - Documentation updates

### Commit Convention

```bash
# Format: <type>(<scope>): <subject>

feat(mining): add SHA3 algorithm support
fix(p2p): resolve connection timeout issue
docs(api): update REST endpoint documentation
test(pool): add integration tests for payout
refactor(db): optimize query performance
style(ui): fix indentation in templates
chore(deps): update Go modules
```

## 🚀 Deployment

### Local Build

```bash
# Build for current platform
go build -o otedama cmd/otedama/main.go

# Cross-compile for Linux
GOOS=linux GOARCH=amd64 go build -o otedama-linux cmd/otedama/main.go

# Build with version info
go build -ldflags "-X main.Version=v2.1.5" -o otedama cmd/otedama/main.go
```

### Production Build

```bash
# Optimized production build
CGO_ENABLED=0 GOOS=linux go build \
  -a -installsuffix cgo \
  -ldflags '-s -w -extldflags "-static"' \
  -o otedama cmd/otedama/main.go
```

## 📝 Documentation

### Code Documentation

- Add godoc comments to all exported items
- Include examples in doc comments
- Keep documentation synchronized with code

### API Documentation

```bash
# Generate OpenAPI spec
go run cmd/otedama/main.go --generate-openapi > api/openapi.yaml

# Serve documentation
docker run -p 8081:8080 \
  -e SWAGGER_JSON=/api/openapi.yaml \
  -v $(pwd)/api:/api \
  swaggerapi/swagger-ui
```

## 🧪 Continuous Integration

### GitHub Actions

See `.github/workflows/` for CI/CD pipelines:
- `test.yml` - Run tests on PR
- `build.yml` - Build binaries
- `deploy.yml` - Deploy to production

### Pre-commit Hooks

```bash
# Install pre-commit
pip install pre-commit

# Setup hooks
pre-commit install

# Run manually
pre-commit run --all-files
```

## 📚 Resources

### Internal Documentation
- [Architecture](./docs/en/ARCHITECTURE.md)
- [API Reference](./docs/en/API.md)
- [Security Guide](./docs/en/SECURITY.md)

### External Resources
- [Effective Go](https://golang.org/doc/effective_go)
- [Go Code Review Comments](https://github.com/golang/go/wiki/CodeReviewComments)
- [Twelve-Factor App](https://12factor.net/)

## 🆘 Getting Help

- Check [Documentation](./docs/)
- Search [GitHub Issues](https://github.com/shizukutanaka/Otedama/issues)
- Ask in [Discussions](https://github.com/shizukutanaka/Otedama/discussions)
- Join Discord (Coming Soon)

---

*Happy coding! Remember to follow the [Contributing Guidelines](./CONTRIBUTING.md) when submitting changes.*