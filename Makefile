# Otedama Mining Pool - Developer Makefile
.PHONY: help build test dev prod clean docker-up docker-down logs

# Default target
help:
	@echo "Otedama Mining Pool - Development Commands"
	@echo ""
	@echo "Development:"
	@echo "  make dev              - Start development environment"
	@echo "  make dev-integrated   - Start integrated development environment"
	@echo "  make proxy            - Start mining proxy server"
	@echo "  make watch            - Start with hot reload"
	@echo ""
	@echo "Docker:"
	@echo "  make docker-up        - Start all services with Docker Compose"
	@echo "  make docker-down      - Stop all Docker services"
	@echo "  make docker-build     - Build Docker images"
	@echo "  make docker-logs      - Show Docker logs"
	@echo ""
	@echo "Testing:"
	@echo "  make test             - Run all tests"
	@echo "  make test-unit        - Run unit tests"
	@echo "  make test-integration - Run integration tests"
	@echo "  make test-performance - Run performance tests"
	@echo "  make test-coverage    - Run tests with coverage"
	@echo ""
	@echo "Build:"
	@echo "  make build            - Build TypeScript"
	@echo "  make build-prod       - Build for production"
	@echo "  make clean            - Clean build artifacts"
	@echo ""
	@echo "Database:"
	@echo "  make db-migrate       - Run database migrations"
	@echo "  make db-seed          - Seed database with test data"
	@echo "  make db-reset         - Reset database"
	@echo ""
	@echo "Deployment:"
	@echo "  make k8s-deploy       - Deploy to Kubernetes"
	@echo "  make k8s-delete       - Delete from Kubernetes"
	@echo "  make helm-install     - Install with Helm"
	@echo ""
	@echo "Utilities:"
	@echo "  make lint             - Run linter"
	@echo "  make format           - Format code"
	@echo "  make docs             - Generate documentation"
	@echo "  make api-docs         - Open API documentation"
	@echo "  make metrics          - Open Grafana dashboard"

# Development targets
dev:
	npm run dev

dev-integrated:
	npm run dev:integrated

proxy:
	node dist/proxy-server.js

watch:
	npm run dev:watch

# Docker targets
docker-up:
	docker-compose -f docker-compose.dev.yml up -d

docker-down:
	docker-compose -f docker-compose.dev.yml down

docker-build:
	docker-compose -f docker-compose.dev.yml build

docker-logs:
	docker-compose -f docker-compose.dev.yml logs -f

docker-clean:
	docker-compose -f docker-compose.dev.yml down -v
	docker system prune -f

# Testing targets
test:
	npm test

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

test-performance:
	npm run test:performance

test-coverage:
	npm run test:coverage

test-docker:
	docker-compose -f docker-compose.dev.yml --profile test up miner-simulator

# Build targets
build:
	npm run build

build-prod:
	NODE_ENV=production npm run build

clean:
	rm -rf dist/
	rm -rf node_modules/
	rm -rf coverage/
	rm -rf logs/

install:
	npm ci

# Database targets
db-migrate:
	npm run db:migrate

db-seed:
	npm run db:seed

db-reset:
	npm run db:reset

db-backup:
	@echo "Backing up database..."
	@docker exec otedama-postgres pg_dump -U otedama otedama > backup-$$(date +%Y%m%d-%H%M%S).sql

# Kubernetes targets
k8s-deploy:
	kubectl apply -f k8s/otedama-pool.yaml

k8s-delete:
	kubectl delete -f k8s/otedama-pool.yaml

k8s-logs:
	kubectl logs -n otedama-pool -l app=otedama-pool -f

k8s-scale:
	kubectl scale deployment otedama-pool -n otedama-pool --replicas=$(REPLICAS)

# Helm targets
helm-install:
	helm install otedama-pool ./helm/otedama-pool

helm-upgrade:
	helm upgrade otedama-pool ./helm/otedama-pool

helm-uninstall:
	helm uninstall otedama-pool

# Utility targets
lint:
	npm run lint

format:
	npm run format

docs:
	npm run docs

api-docs:
	@echo "Opening API documentation..."
	@open http://localhost:8088/api-docs || xdg-open http://localhost:8088/api-docs

metrics:
	@echo "Opening Grafana dashboard..."
	@open http://localhost:3000 || xdg-open http://localhost:3000

logs:
	tail -f logs/*.log

# Environment setup
setup-dev:
	@echo "Setting up development environment..."
	@cp .env.integrated .env
	@npm install
	@make docker-up
	@echo "Waiting for services to start..."
	@sleep 10
	@make db-migrate
	@echo "Development environment ready!"

# Production build
prod:
	@echo "Building for production..."
	@make clean
	@make install
	@make build-prod
	@docker build -f Dockerfile.optimized --target production -t otedama/pool:latest .
	@echo "Production build complete!"

# Generate configurations
generate-configs:
	GENERATE_CONFIGS=true npm start

# Benchmarks
benchmark:
	npm run benchmark

benchmark-algorithms:
	node dist/test/benchmark-algorithms.js

# Security scan
security-scan:
	npm audit
	npm run security:check

# Check dependencies
check-deps:
	npm outdated

update-deps:
	npm update

# Git hooks
install-hooks:
	npx husky install

# Release
release-patch:
	npm version patch

release-minor:
	npm version minor

release-major:
	npm version major

# Development with specific features
dev-mobile:
	PUSH_NOTIFICATIONS=true JWT_SECRET=dev-secret npm run dev:integrated

dev-multi-algo:
	MULTI_ALGORITHM_ENABLED=true SUPPORTED_ALGORITHMS=sha256d,scrypt,x11 npm run dev:integrated

dev-merge-mining:
	docker-compose -f docker-compose.dev.yml --profile merge-mining up -d
	MERGE_MINING_ENABLED=true npm run dev:integrated

# Debug utilities
debug-redis:
	docker-compose -f docker-compose.dev.yml --profile debug up -d redis-commander

debug-db:
	docker-compose -f docker-compose.dev.yml --profile debug up -d adminer

# Performance profiling
profile:
	node --inspect dist/main-integrated.js

profile-heap:
	node --inspect --heap-prof dist/main-integrated.js

# Load testing
load-test:
	npm run test:load

stress-test:
	WORKERS=100 DURATION=300 npm run test:stress
