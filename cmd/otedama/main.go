package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/core"
	"github.com/otedama/otedama/internal/logging"
	"go.uber.org/zap"
)

var (
	configFile   = flag.String("config", "config.yaml", "設定ファイルパス")
	mode         = flag.String("mode", "auto", "動作モード (solo, pool, miner)")
	poolAddr     = flag.String("pool", "", "プールアドレス (minerモード時)")
	stratumPort  = flag.String("stratum", ":3333", "Stratumサーバーポート")
	p2pPort      = flag.String("p2p", ":30303", "P2Pネットワークポート")
	apiPort      = flag.String("api", ":8080", "APIサーバーポート")
	cpuOnly      = flag.Bool("cpu-only", false, "CPUのみ使用")
	gpuOnly      = flag.Bool("gpu-only", false, "GPUのみ使用")
	asicOnly     = flag.Bool("asic-only", false, "ASICのみ使用")
	threads      = flag.Int("threads", 0, "CPUスレッド数 (0=自動)")
	logLevel     = flag.String("log-level", "info", "ログレベル (debug, info, warn, error)")
	version      = flag.Bool("version", false, "バージョン情報を表示")
)

const (
	AppName    = "Otedama"
	AppVersion = "1.5.0"
)

func main() {
	flag.Parse()

	if *version {
		fmt.Printf("%s v%s\n", AppName, AppVersion)
		fmt.Printf("Go version: %s\n", runtime.Version())
		fmt.Printf("OS/Arch: %s/%s\n", runtime.GOOS, runtime.GOARCH)
		os.Exit(0)
	}

	// ロガー初期化
	logConfig := logging.Config{
		Level:            logging.LogLevel(*logLevel),
		Encoding:         "json",
		Filename:         "logs/otedama.log",
		MaxSize:          100, // 100MB
		MaxBackups:       10,
		MaxAge:           30, // 30 days
		Compress:         true,
		EnableSampling:   true,
		SampleInitial:    100,
		SampleInterval:   100,
		AuditConfig: logging.AuditConfig{
			Enabled:        true,
			LogFile:        "logs/audit.log",
			MaxFileSize:    50,
			MaxBackups:     20,
			MaxAge:         90,
			BufferSize:     1000,
			FlushInterval:  10,
			IncludeDebug:   false,
			EncryptLogs:    false,
		},
	}
	
	logManager, err := logging.NewManager(logConfig)
	if err != nil {
		log.Fatalf("Failed to initialize logging manager: %v", err)
	}
	defer logManager.Close()
	
	logger := logManager.GetLogger()
	
	// Log startup event
	logManager.LogStartup(AppVersion, *mode, map[string]interface{}{
		"cpu_cores": runtime.NumCPU(),
		"go_version": runtime.Version(),
		"os_arch": fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
	})

	// 設定読み込み
	cfg, err := config.Load(*configFile)
	if err != nil {
		logger.Fatal("Failed to load config", zap.Error(err))
	}

	// コマンドラインオプションで設定を上書き
	applyCommandLineOptions(cfg)

	// システム初期化
	system, err := core.NewSystem(cfg, logger, logManager)
	if err != nil {
		logger.Fatal("Failed to initialize system", zap.Error(err))
	}

	// コンテキスト作成
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// シグナルハンドリング
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// システム開始
	if err := system.Start(ctx); err != nil {
		logger.Fatal("Failed to start system", zap.Error(err))
	}

	logger.Info("Otedama is running",
		zap.String("mode", cfg.Mode),
		zap.String("api", cfg.API.ListenAddr),
	)

	// シグナル待機
	var shutdownReason string
	select {
	case sig := <-sigChan:
		shutdownReason = fmt.Sprintf("signal_%s", sig.String())
		logger.Info("Received signal", zap.String("signal", sig.String()))
	case <-ctx.Done():
		shutdownReason = "context_cancelled"
		logger.Info("Context cancelled")
	}

	// グレースフルシャットダウン
	logger.Info("Shutting down...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := system.Shutdown(shutdownCtx); err != nil {
		logManager.LogError("main", "shutdown", err, map[string]interface{}{
			"reason": shutdownReason,
		})
	}

	logManager.LogShutdown(shutdownReason)
}


func applyCommandLineOptions(cfg *config.Config) {
	// モード設定
	if *mode != "auto" {
		cfg.Mode = *mode
	}

	// ネットワーク設定
	if *stratumPort != ":3333" {
		cfg.Stratum.ListenAddr = *stratumPort
	}
	if *p2pPort != ":30303" {
		cfg.Network.ListenAddr = *p2pPort
	}
	if *apiPort != ":8080" {
		cfg.API.ListenAddr = *apiPort
	}

	// ハードウェア設定
	if *cpuOnly {
		cfg.Mining.EnableCPU = true
		cfg.Mining.EnableGPU = false
		cfg.Mining.EnableASIC = false
	} else if *gpuOnly {
		cfg.Mining.EnableCPU = false
		cfg.Mining.EnableGPU = true
		cfg.Mining.EnableASIC = false
	} else if *asicOnly {
		cfg.Mining.EnableCPU = false
		cfg.Mining.EnableGPU = false
		cfg.Mining.EnableASIC = true
	}

	// スレッド数設定
	if *threads > 0 {
		cfg.Mining.Threads = *threads
	}

	// プールアドレス設定（minerモード時）
	if *poolAddr != "" && cfg.Mode == "miner" {
		cfg.Mining.Pools = []config.PoolConfig{
			{
				URL:      *poolAddr,
				User:     "default",
				Pass:     "x",
				Priority: 1,
			},
		}
	}
}