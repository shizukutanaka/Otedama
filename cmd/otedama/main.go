package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/core"
	"go.uber.org/zap"
)

var (
	configFile = flag.String("config", "config.yaml", "Configuration file path")
	mode       = flag.String("mode", "auto", "Operation mode (solo, pool, miner, auto)")
	cpuOnly    = flag.Bool("cpu-only", false, "Use CPU only")
	threads    = flag.Int("threads", 0, "CPU thread count (0=auto)")
	logLevel   = flag.String("log-level", "info", "Log level (debug, info, warn, error)")
	version    = flag.Bool("version", false, "Show version information")
	init       = flag.Bool("init", false, "Generate initial configuration file")
	benchmark  = flag.Bool("benchmark", false, "Run performance benchmark")
	
	// ZKP options
	zkp        = flag.Bool("zkp", true, "Enable Zero-Knowledge Proof authentication")
	noKYC      = flag.Bool("no-kyc", true, "Disable KYC requirements (use ZKP instead)")
	anonymous  = flag.Bool("anonymous", false, "Enable anonymous mining")
	
	// Advanced options
	enterprise = flag.Bool("enterprise", false, "Enable enterprise features")
	tor        = flag.Bool("tor", false, "Enable Tor support")
	i2p        = flag.Bool("i2p", false, "Enable I2P support")
)

const (
	AppName    = "Otedama"
	AppVersion = "3.0.0"
	AppAuthor  = "Otedama Development Team"
)

func main() {
	flag.Parse()

	if *version {
		printVersionInfo()
		os.Exit(0)
	}

	if *init {
		if err := config.GenerateSampleConfig(*configFile); err != nil {
			log.Fatalf("Failed to generate configuration: %v", err)
		}
		fmt.Printf("Configuration file '%s' generated successfully.\n", *configFile)
		fmt.Println("Edit the configuration file to customize your settings.")
		os.Exit(0)
	}

	if *benchmark {
		runBenchmark()
		os.Exit(0)
	}

	// Initialize logger
	logger, err := initLogger(*logLevel)
	if err != nil {
		log.Fatalf("Failed to initialize logger: %v", err)
	}
	defer logger.Sync()

	// Load or generate configuration
	cfg, err := config.LoadOrGenerate(*configFile)
	if err != nil {
		if err.Error() == "configuration file created, please review and restart" {
			fmt.Println("\nPlease review the generated configuration and restart Otedama.")
			os.Exit(0)
		}
		logger.Fatal("Failed to load configuration", zap.Error(err))
	}
	
	// Validate data directory
	if err := config.ValidateDataDir(cfg.GetDataDir()); err != nil {
		logger.Fatal("Failed to validate data directory", zap.Error(err))
	}

	// Apply command line overrides
	applyCommandLineOptions(cfg)

	// Create and start Otedama system
	system, err := core.NewOtedamaSystem(cfg, logger)
	if err != nil {
		logger.Fatal("Failed to create Otedama system", zap.Error(err))
	}

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start system
	if err := system.Start(ctx); err != nil {
		logger.Fatal("Failed to start system", zap.Error(err))
	}

	// Display startup info
	displayStartupInfo(cfg)

	// Wait for shutdown signal
	<-sigChan
	logger.Info("Received shutdown signal")

	// Graceful shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := system.Stop(shutdownCtx); err != nil {
		logger.Error("Shutdown error", zap.Error(err))
	}

	fmt.Println("\nOtedama stopped successfully.")
	fmt.Println("Thank you for using Otedama!")
}

func printVersionInfo() {
	fmt.Printf("%s v%s - P2P Mining Pool with Zero-Knowledge Proof\n", AppName, AppVersion)
	fmt.Printf("Author:     %s\n", AppAuthor)
	fmt.Printf("Go version: %s\n", runtime.Version())
	fmt.Printf("OS/Arch:    %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("CPU cores:  %d\n", runtime.NumCPU())
	fmt.Printf("\nFeatures:\n")
	fmt.Printf("  - Zero-Knowledge Proof authentication (no KYC required)\n")
	fmt.Printf("  - P2P decentralized mining pool\n")
	fmt.Printf("  - Multi-algorithm support (SHA256d, Ethash, KawPow, RandomX)\n")
	fmt.Printf("  - CPU, GPU, and ASIC mining\n")
	fmt.Printf("  - Enterprise-grade security and compliance\n")
	fmt.Printf("  - Anonymous mining support\n")
	fmt.Printf("  - Tor and I2P integration\n")
}

func initLogger(level string) (*zap.Logger, error) {
	var zapLevel zap.AtomicLevel
	
	switch level {
	case "debug":
		zapLevel = zap.NewAtomicLevelAt(zap.DebugLevel)
	case "info":
		zapLevel = zap.NewAtomicLevelAt(zap.InfoLevel)
	case "warn":
		zapLevel = zap.NewAtomicLevelAt(zap.WarnLevel)
	case "error":
		zapLevel = zap.NewAtomicLevelAt(zap.ErrorLevel)
	default:
		zapLevel = zap.NewAtomicLevelAt(zap.InfoLevel)
	}

	config := zap.Config{
		Level:       zapLevel,
		Development: false,
		Sampling: &zap.SamplingConfig{
			Initial:    100,
			Thereafter: 100,
		},
		Encoding:         "console",
		EncoderConfig:    zap.NewProductionEncoderConfig(),
		OutputPaths:      []string{"stderr", "logs/otedama.log"},
		ErrorOutputPaths: []string{"stderr"},
	}
	
	// Create logs directory if it doesn't exist
	os.MkdirAll("logs", 0755)

	return config.Build()
}

func applyCommandLineOptions(cfg *config.Config) {
	if *mode != "auto" {
		cfg.Mode = *mode
	}

	if *cpuOnly {
		cfg.Mining.HardwareType = "cpu"
		cfg.Mining.EnableCPU = true // Legacy support
		cfg.Mining.EnableGPU = false
		cfg.Mining.EnableASIC = false
	}

	if *threads > 0 {
		cfg.Mining.Threads = *threads
	}
	
	// Apply ZKP options
	if *zkp {
		cfg.ZKP.Enabled = true
	}
	
	if *noKYC {
		cfg.ZKP.RequireAgeProof = true // Use age proof instead of KYC
		// Note: RequireIdentityProof field doesn't exist in config
	}
	
	if *anonymous {
		cfg.Privacy.AnonymousMining = true
	}
	
	// Apply privacy options
	if *tor {
		cfg.Privacy.EnableTor = true
	}
	
	if *i2p {
		cfg.Privacy.EnableI2P = true
	}
	
	// Enable enterprise features if requested
	if *enterprise {
		// Enable enterprise-grade features
		cfg.Security.EnableEncryption = true
		cfg.Monitoring.EnableProfiler = true // Fixed field name
		cfg.Performance.EnableOptimization = true
	}
}

func displayStartupInfo(cfg *config.Config) {
	fmt.Printf("\n")
	fmt.Printf("╔══════════════════════════════════════════════════════╗\n")
	fmt.Printf("║              Otedama v%s                       ║\n", AppVersion)
	fmt.Printf("║     P2P Mining Pool with Zero-Knowledge Proof        ║\n")
	fmt.Printf("╠══════════════════════════════════════════════════════╣\n")
	fmt.Printf("║ Mode:               %-32s ║\n", cfg.Mode)
	fmt.Printf("║ Algorithm:          %-32s ║\n", cfg.Mining.Algorithm)
	fmt.Printf("║ Hardware Type:      %-32s ║\n", cfg.GetHardwareType())
	fmt.Printf("║ Threads:            %-32d ║\n", cfg.Mining.Threads)
	fmt.Printf("║ Auto Tuning:        %-32t ║\n", cfg.Mining.AutoTuning)
	fmt.Printf("╠══════════════════════════════════════════════════════╣\n")
	fmt.Printf("║ Zero-Knowledge Proof:                                ║\n")
	fmt.Printf("║   Enabled:          %-32t ║\n", cfg.ZKP.Enabled)
	fmt.Printf("║   Age Verification: %-32t ║\n", cfg.ZKP.RequireAgeProof)
	fmt.Printf("║   KYC Required:     %-32t ║\n", false) // ZKP replaces KYC
	fmt.Printf("║   Anonymous Mining: %-32t ║\n", cfg.Privacy.AnonymousMining)
	fmt.Printf("╠══════════════════════════════════════════════════════╣\n")
	fmt.Printf("║ Network:                                             ║\n")
	fmt.Printf("║   P2P Port:         %-32s ║\n", cfg.Network.ListenAddr)
	fmt.Printf("║   API Server:       %-32s ║\n", cfg.API.ListenAddr)
	
	if cfg.Dashboard.Enabled {
		fmt.Printf("║   Dashboard:        %-32s ║\n", cfg.Dashboard.ListenAddr)
	}
	
	if cfg.Stratum.Enabled {
		fmt.Printf("║   Stratum Port:     %-32s ║\n", cfg.Stratum.ListenAddr)
	}
	
	if cfg.Privacy.EnableTor {
		fmt.Printf("║   Tor:              %-32s ║\n", "Enabled")
	}
	
	if cfg.Privacy.EnableI2P {
		fmt.Printf("║   I2P:              %-32s ║\n", "Enabled")
	}
	
	fmt.Printf("╚══════════════════════════════════════════════════════╝\n")
	fmt.Printf("\n")
	
	if cfg.ZKP.Enabled {
		fmt.Printf("✓ No KYC required - using Zero-Knowledge Proofs for verification\n")
	}
	
	if cfg.Privacy.AnonymousMining {
		fmt.Printf("✓ Anonymous mining enabled - your identity is protected\n")
	}
	
	fmt.Printf("\nPress Ctrl+C to stop\n\n")
}

func runBenchmark() {
	fmt.Println("Running Otedama comprehensive performance benchmark...")
	fmt.Println(strings.Repeat("=", 60))
	
	// Initialize logger
	logger, err := initLogger("info")
	if err != nil {
		log.Fatalf("Failed to initialize logger: %v", err)
	}
	defer logger.Sync()
	
	// Create a minimal config for benchmarking
	cfg := &config.Config{
		Mode:     "benchmark",
		LogLevel: "info",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "auto",
			AutoDetect:   true,
		},
		ZKP: config.ZKPConfig{
			Enabled: true,
		},
		Profiling: config.ProfilingConfig{
			Enabled:    true,
			PProfAddr:  "localhost:6060",
			ProfileDir: "./benchmark-profiles",
		},
	}
	
	// Create benchmarking context
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	
	// Create system
	system, err := core.NewOtedamaSystem(cfg, logger)
	if err != nil {
		logger.Fatal("Failed to create system for benchmarking", zap.Error(err))
	}
	
	// Run benchmarks
	if err := system.RunBenchmarks(ctx); err != nil {
		logger.Error("Benchmarks failed", zap.Error(err))
	}
	
	// Get and display results
	results := system.GetBenchmarkResults()
	
	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("BENCHMARK SUMMARY")
	fmt.Println(strings.Repeat("=", 60))
	
	// Mining performance
	if result, exists := results["mining_sha256d"]; exists {
		if hashrate, ok := result.Metrics["hashrate_mhs"].(float64); ok {
			fmt.Printf("SHA256d Performance:     %.2f MH/s\n", hashrate)
		}
	}
	
	// ZKP performance
	if result, exists := results["zkp_gen_groth16"]; exists {
		fmt.Printf("Groth16 Proof Gen:       %.0f proofs/sec\n", result.OpsPerSecond)
	}
	
	if result, exists := results["zkp_verify_groth16"]; exists {
		fmt.Printf("Groth16 Proof Verify:    %.0f verifications/sec\n", result.OpsPerSecond)
	}
	
	// Memory performance
	if result, exists := results["memory_allocation"]; exists {
		fmt.Printf("Memory Allocation:       %.0f ops/sec\n", result.OpsPerSecond)
	}
	
	// Network performance
	if result, exists := results["network_serialization"]; exists {
		fmt.Printf("Message Serialization:   %.0f msgs/sec\n", result.OpsPerSecond)
	}
	
	// Profiler stats
	profStats := system.GetProfilerStats()
	if profStats != nil {
		fmt.Println("\nSystem Resources:")
		if mem, ok := profStats["memory"].(map[string]interface{}); ok {
			fmt.Printf("Memory Used:             %v MB\n", mem["alloc_mb"])
			fmt.Printf("Total Allocated:         %v MB\n", mem["total_alloc_mb"])
		}
		if runtime, ok := profStats["runtime"].(map[string]interface{}); ok {
			fmt.Printf("Goroutines:              %v\n", runtime["goroutines"])
			fmt.Printf("CPU Cores:               %v\n", runtime["cpus"])
		}
	}
	
	fmt.Println(strings.Repeat("=", 60))
	fmt.Println("\nBenchmark complete. Detailed report saved to benchmark-report.txt")
}

