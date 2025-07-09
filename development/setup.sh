#!/bin/bash
# 開発環境セットアップ - 軽量版

echo "🚀 Otedama Pool 開発環境セットアップ開始..."

# 環境変数ファイル作成
create_env() {
    if [ ! -f .env.development ]; then
        cat > .env.development << EOF
NODE_ENV=development
API_PORT=3000
STRATUM_PORT=3333
DATABASE_URL=postgresql://otedama:dev_password@localhost:5432/otedama_dev
REDIS_URL=redis://localhost:6379/0
JWT_SECRET=dev-jwt-secret
LOG_LEVEL=debug
POOL_ADDRESS=bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
POOL_FEE=1.0
EOF
        echo "✓ .env.development 作成完了"
    fi
}

# ディレクトリ作成
create_dirs() {
    mkdir -p logs data backups development/dashboards sql/init
    echo "✓ ディレクトリ作成完了"
}

# pgAdmin設定
create_pgadmin_config() {
    cat > development/pgadmin-servers.json << EOF
{
    "Servers": {
        "1": {
            "Name": "Otedama Dev",
            "Group": "Servers",
            "Host": "postgres",
            "Port": 5432,
            "MaintenanceDB": "otedama_dev",
            "Username": "otedama"
        }
    }
}
EOF
    echo "✓ pgAdmin設定作成完了"
}

# 実行
create_env
create_dirs
create_pgadmin_config

echo "🎉 開発環境セットアップ完了！"
echo ""
echo "次のコマンドで起動:"
echo "docker-compose -f docker-compose.dev.yml up -d"