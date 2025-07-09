#!/bin/bash

# Otedama Pool 開発環境セットアップスクリプト
# 開発に必要な環境とツールを自動セットアップ

set -e  # エラー時に停止

echo "🚀 Otedama Pool 開発環境セットアップ開始..."

# カラー定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ログ関数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 必要な依存関係をチェック
check_dependencies() {
    log_info "必要な依存関係をチェック中..."
    
    local missing_deps=()
    
    # Docker
    if ! command -v docker &> /dev/null; then
        missing_deps+=("docker")
    fi
    
    # Docker Compose
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        missing_deps+=("docker-compose")
    fi
    
    # Node.js
    if ! command -v node &> /dev/null; then
        missing_deps+=("node")
    fi
    
    # npm
    if ! command -v npm &> /dev/null; then
        missing_deps+=("npm")
    fi
    
    # Git
    if ! command -v git &> /dev/null; then
        missing_deps+=("git")
    fi
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        log_error "以下の依存関係が不足しています:"
        printf '%s\n' "${missing_deps[@]}"
        log_info "以下のコマンドでインストールしてください（Ubuntu/Debian）:"
        echo "sudo apt update"
        echo "sudo apt install -y docker.io docker-compose nodejs npm git"
        echo "sudo usermod -aG docker \$USER"
        echo "（ログアウト後、再ログインしてください）"
        exit 1
    fi
    
    log_success "依存関係チェック完了"
}

# 環境変数ファイルを作成
create_env_files() {
    log_info "環境変数ファイルを作成中..."
    
    # .env.development
    if [ ! -f .env.development ]; then
        cat > .env.development << EOF
# 開発環境用設定
NODE_ENV=development
API_PORT=3000
STRATUM_PORT=3333

# データベース
DATABASE_URL=postgresql://otedama:dev_password@localhost:5432/otedama_dev
DB_HOST=localhost
DB_PORT=5432
DB_NAME=otedama_dev
DB_USER=otedama
DB_PASSWORD=dev_password
DB_SSL=false

# Redis
REDIS_URL=redis://localhost:6379/0
REDIS_HOST=localhost
REDIS_PORT=6379

# セキュリティ
JWT_SECRET=dev-jwt-secret-change-me
JWT_EXPIRATION=24h
BCRYPT_ROUNDS=8

# プール設定
POOL_ADDRESS=bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
POOL_FEE=1.0
MIN_PAYOUT=0.0001

# ログ
LOG_LEVEL=debug
LOG_FILE=true

# デバッグ
ENABLE_DEBUG=true
ENABLE_HOT_RELOAD=true
DEBUG_PORT=9229

# 監視
MONITORING_ENABLED=true
METRICS_PORT=9090

# メール（開発用）
MAIL_HOST=localhost
MAIL_PORT=1025
MAIL_USER=
MAIL_PASS=
EOF
        log_success ".env.development ファイルを作成しました"
    else
        log_info ".env.development は既に存在します"
    fi
    
    # .env（デフォルト）
    if [ ! -f .env ]; then
        cp .env.development .env
        log_success ".env ファイルを作成しました"
    else
        log_info ".env は既に存在します"
    fi
}

# 開発用設定ファイルを作成
create_dev_configs() {
    log_info "開発用設定ファイルを作成中..."
    
    # pgAdmin設定
    cat > development/pgadmin-servers.json << EOF
{
    "Servers": {
        "1": {
            "Name": "Otedama Dev",
            "Group": "Servers",
            "Host": "postgres",
            "Port": 5432,
            "MaintenanceDB": "otedama_dev",
            "Username": "otedama",
            "SSLMode": "prefer",
            "SSLCert": "<STORAGE_DIR>/.postgresql/postgresql.crt",
            "SSLKey": "<STORAGE_DIR>/.postgresql/postgresql.key",
            "SSLCompression": 0,
            "Timeout": 10,
            "UseSSHTunnel": 0,
            "TunnelPort": "22",
            "TunnelAuthentication": 0
        }
    }
}
EOF
    
    # Prometheus設定
    cat > development/prometheus-dev.yml << EOF
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'otedama-pool'
    static_configs:
      - targets: ['otedama-dev:9090']
    scrape_interval: 5s
    metrics_path: '/metrics'

  - job_name: 'redis'
    static_configs:
      - targets: ['redis:6379']

  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres:5432']
EOF
    
    # Grafana データソース設定
    cat > development/grafana-datasources.yml << EOF
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
EOF
    
    # Grafana ダッシュボード設定
    cat > development/grafana-dashboards.yml << EOF
apiVersion: 1

providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
EOF
    
    log_success "開発用設定ファイルを作成しました"
}

# 必要なディレクトリを作成
create_directories() {
    log_info "必要なディレクトリを作成中..."
    
    local dirs=(
        "logs"
        "data"
        "backups"
        "development/dashboards"
        "sql/init"
        "sql/dev-data"
        "tests/fixtures"
        "docs/api"
    )
    
    for dir in "${dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir"
            log_success "ディレクトリ '$dir' を作成しました"
        fi
    done
}

# npm依存関係をインストール
install_npm_dependencies() {
    log_info "npm依存関係をインストール中..."
    
    if [ ! -d "node_modules" ]; then
        npm install
        log_success "npm依存関係をインストールしました"
    else
        log_info "node_modules は既に存在します。npm install をスキップ"
        log_warning "最新の依存関係を確認するには 'npm install' を実行してください"
    fi
}

# 開発用データベース初期化SQL
create_init_sql() {
    log_info "開発用データベース初期化SQLを作成中..."
    
    cat > sql/dev-data/01-dev-data.sql << EOF
-- 開発用テストデータ

-- テストユーザー
INSERT INTO users (username, email, password_hash, wallet_address, created_at) VALUES
('testuser', 'test@example.com', '\$2b\$08\$hash', 'bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', NOW()),
('devuser', 'dev@example.com', '\$2b\$08\$hash', 'bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', NOW());

-- テストワーカー
INSERT INTO workers (user_id, name, difficulty, last_seen, created_at) VALUES
(1, 'testworker1', 1.0, NOW(), NOW()),
(1, 'testworker2', 1.0, NOW(), NOW()),
(2, 'devworker1', 1.0, NOW(), NOW());

-- サンプル統計データ
INSERT INTO pool_stats (timestamp, total_hashrate, active_miners, blocks_found, pool_luck) VALUES
(NOW() - INTERVAL '1 hour', 1000000, 5, 1, 105.2),
(NOW() - INTERVAL '2 hours', 950000, 4, 0, 95.8),
(NOW() - INTERVAL '3 hours', 1100000, 6, 2, 198.5);
EOF
    
    log_success "開発用データベース初期化SQLを作成しました"
}

# Docker環境を起動
start_docker_environment() {
    log_info "Docker環境を起動中..."
    
    # 既存のコンテナを停止
    docker-compose -f docker-compose.dev.yml down > /dev/null 2>&1 || true
    
    # 新しい環境を起動
    docker-compose -f docker-compose.dev.yml up -d
    
    log_success "Docker環境を起動しました"
    
    # ヘルスチェック
    log_info "サービスの起動を待機中..."
    sleep 10
    
    # PostgreSQL接続確認
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if docker-compose -f docker-compose.dev.yml exec -T postgres pg_isready -U otedama -d otedama_dev > /dev/null 2>&1; then
            log_success "PostgreSQLが起動しました"
            break
        fi
        
        if [ $attempt -eq $max_attempts ]; then
            log_error "PostgreSQLの起動に失敗しました"
            exit 1
        fi
        
        log_info "PostgreSQLの起動を待機中... ($attempt/$max_attempts)"
        sleep 2
        ((attempt++))
    done
}

# 開発用スクリプトを作成
create_dev_scripts() {
    log_info "開発用スクリプトを作成中..."
    
    # package.jsonに開発用スクリプトを追加（既存の場合はスキップ）
    cat > scripts/dev.js << 'EOF'
// 開発サーバー起動スクリプト
const { spawn } = require('child_process');
const chokidar = require('chokidar');

let server;

function startServer() {
  if (server) {
    server.kill();
  }
  
  console.log('🚀 Starting development server...');
  server = spawn('node', ['--inspect=0.0.0.0:9229', 'dist/server.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development'
    }
  });
  
  server.on('error', (err) => {
    console.error('Server error:', err);
  });
}

function restartServer() {
  console.log('🔄 Restarting server...');
  startServer();
}

// ファイル監視
const watcher = chokidar.watch(['dist/**/*.js'], {
  ignored: /node_modules/,
  persistent: true
});

watcher.on('change', restartServer);
watcher.on('add', restartServer);
watcher.on('unlink', restartServer);

console.log('👀 Watching for changes...');
startServer();

process.on('SIGTERM', () => {
  if (server) server.kill();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (server) server.kill();
  process.exit(0);
});
EOF
    
    mkdir -p scripts
    
    log_success "開発用スクリプトを作成しました"
}

# サマリー表示
show_summary() {
    log_success "🎉 開発環境のセットアップが完了しました！"
    echo ""
    echo "📋 利用可能なサービス:"
    echo "  • アプリケーション: http://localhost:3000"
    echo "  • Stratum サーバー: localhost:3333"
    echo "  • pgAdmin: http://localhost:8080 (admin@otedama.dev / admin123)"
    echo "  • Redis Commander: http://localhost:8081"
    echo "  • Grafana: http://localhost:3001 (admin / admin123)"
    echo "  • Prometheus: http://localhost:9000"
    echo "  • MailCatcher: http://localhost:1080"
    echo ""
    echo "🔧 開発用コマンド:"
    echo "  • npm run dev          # 開発サーバー起動"
    echo "  • npm run build        # ビルド"
    echo "  • npm run test         # テスト実行"
    echo "  • npm run lint         # リント実行"
    echo "  • npm run db:migrate   # データベースマイグレーション"
    echo ""
    echo "🐳 Docker操作:"
    echo "  • docker-compose -f docker-compose.dev.yml up -d    # サービス起動"
    echo "  • docker-compose -f docker-compose.dev.yml down     # サービス停止"
    echo "  • docker-compose -f docker-compose.dev.yml logs -f  # ログ表示"
    echo ""
    echo "📁 重要なファイル:"
    echo "  • .env.development     # 開発環境設定"
    echo "  • config/development.json # アプリケーション設定"
    echo "  • docker-compose.dev.yml  # Docker Compose設定"
    echo ""
    log_warning "初回起動時は、データベースマイグレーションを実行してください:"
    echo "  npm run db:migrate"
}

# メイン実行
main() {
    echo "🏗️  Otedama Pool Development Environment Setup"
    echo "================================================"
    echo ""
    
    check_dependencies
    create_directories
    create_env_files
    create_dev_configs
    create_init_sql
    install_npm_dependencies
    create_dev_scripts
    start_docker_environment
    
    show_summary
}

# スクリプト実行
main "$@"