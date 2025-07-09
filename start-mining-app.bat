@echo off
echo =============================================
echo     Otedama P2P Mining App - Windows
echo =============================================
echo.

REM 管理者権限チェック
net session >nul 2>&1
if %errorLevel% == 0 (
    echo ✅ 管理者権限で実行中
) else (
    echo ⚠️ 最適なパフォーマンスのために管理者権限で実行することをお勧めします
)

REM Node.jsバージョンチェック
node --version >nul 2>&1
if %errorLevel% == 0 (
    echo ✅ Node.js が見つかりました
    node --version
) else (
    echo ❌ Node.js がインストールされていません
    echo https://nodejs.org から Node.js をダウンロードしてインストールしてください
    pause
    exit /b 1
)

echo.
echo 🚀 Otedama Mining App を起動中...
echo.

REM 環境変数設定
if not exist ".env" (
    echo 📝 .envファイルを作成中...
    copy ".env.example" ".env"
    echo ⚠️ .envファイルを編集してペイアウトアドレスを設定してください
)

REM データディレクトリ作成
if not exist "data" mkdir data
if not exist "logs" mkdir logs
if not exist "backups" mkdir backups

REM 依存関係チェック
if not exist "node_modules" (
    echo 📦 依存関係をインストール中...
    npm install
)

REM TypeScript ビルド
echo 🔨 アプリをビルド中...
npm run build

REM アプリ起動
echo ⚡ アプリを起動しています...
echo.
echo 📖 Web UI: http://localhost:8080
echo 📊 メトリクス: http://localhost:9090/metrics
echo 🔌 P2P Port: 6666
echo ⛏️ Stratum Port: 3333
echo.
echo 💡 Ctrl+C でアプリを停止できます
echo.

npm run app:start

pause