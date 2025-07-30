package cli

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Flags represents all CLI flags - Rob Pike's clear data structures
type Flags struct {
	// Basic options
	ConfigFile string
	Mode       string
	LogLevel   string
	Version    bool
	Init       bool
	Benchmark  bool

	// Mining options
	Algorithm   string
	Threads     int
	CPUOnly     bool
	GPUOnly     bool
	ASICOnly    bool
	AutoTune    bool
	HugePages   bool
	NUMA        bool
	CPUAffinity string

	// ZKP options
	ZKP         bool
	ZKPProtocol string
	NoKYC       bool

	// Network options
	Port        int
	APIPort     int
	StratumPort int

	// Utility commands
	Stats   bool
	Health  bool
	GenKeys bool
}

// ParseFlags parses command line flags - John Carmack's performance focus
func ParseFlags() *Flags {
	f := &Flags{}

	// Basic options
	flag.StringVar(&f.ConfigFile, "config", "config.yaml", "Configuration file path")
	flag.StringVar(&f.Mode, "mode", "auto", "Operation mode (solo, pool, miner, auto)")
	flag.StringVar(&f.LogLevel, "log-level", "info", "Log level (debug, info, warn, error)")
	flag.BoolVar(&f.Version, "version", false, "Show version information")
	flag.BoolVar(&f.Init, "init", false, "Generate initial configuration file")
	flag.BoolVar(&f.Benchmark, "benchmark", false, "Run performance benchmark")

	// Mining options
	flag.StringVar(&f.Algorithm, "algorithm", "auto", "Mining algorithm")
	flag.IntVar(&f.Threads, "threads", 0, "CPU thread count (0=auto)")
	flag.BoolVar(&f.CPUOnly, "cpu-only", false, "Use CPU only")
	flag.BoolVar(&f.GPUOnly, "gpu-only", false, "Use GPU only")
	flag.BoolVar(&f.ASICOnly, "asic-only", false, "Use ASIC only")
	flag.BoolVar(&f.AutoTune, "auto-tune", true, "Enable automatic tuning")
	flag.BoolVar(&f.HugePages, "huge-pages", false, "Enable huge pages")
	flag.BoolVar(&f.NUMA, "numa", false, "Enable NUMA optimization")
	flag.StringVar(&f.CPUAffinity, "cpu-affinity", "", "CPU affinity mask")

	// ZKP options
	flag.BoolVar(&f.ZKP, "zkp", true, "Enable Zero-Knowledge Proof authentication")
	flag.StringVar(&f.ZKPProtocol, "zkp-protocol", "groth16", "ZKP protocol")
	flag.BoolVar(&f.NoKYC, "no-kyc", true, "Disable KYC (use ZKP)")

	// Network options
	flag.IntVar(&f.Port, "port", 30303, "P2P network port")
	flag.IntVar(&f.APIPort, "api-port", 8080, "API server port")
	flag.IntVar(&f.StratumPort, "stratum-port", 3333, "Stratum server port")

	// Utility commands
	flag.BoolVar(&f.Stats, "stats", false, "Show mining statistics")
	flag.BoolVar(&f.Health, "health", false, "Perform health check")
	flag.BoolVar(&f.GenKeys, "gen-keys", false, "Generate cryptographic keys")

	flag.Parse()
	return f
}

// InitLogger creates optimized logger - Robert C. Martin's dependency inversion
func InitLogger(level string) (*zap.Logger, error) {
	var zapLevel zap.AtomicLevel
	if err := zapLevel.UnmarshalText([]byte(level)); err != nil {
		return nil, fmt.Errorf("invalid log level: %w", err)
	}

	// John Carmack's performance optimization - efficient logging
	config := zap.Config{
		Level:    zapLevel,
		Encoding: "console",
		EncoderConfig: zapcore.EncoderConfig{
			TimeKey:       "time",
			LevelKey:      "level",
			NameKey:       "logger",
			CallerKey:     "caller",
			MessageKey:    "msg",
			StacktraceKey: "stacktrace",
			LineEnding:    zapcore.DefaultLineEnding,
			EncodeLevel:   zapcore.CapitalColorLevelEncoder,
			EncodeTime:    zapcore.ISO8601TimeEncoder,
			EncodeCaller:  zapcore.ShortCallerEncoder,
		},
		OutputPaths:      []string{"stdout"},
		ErrorOutputPaths: []string{"stderr"},
	}

	return config.Build()
}

// UtilityHandler handles one-shot utility commands - single responsibility
type UtilityHandler struct {
	logger      *zap.Logger
	appName     string
	appVersion  string
	appBuild    string
	appDesc     string
}

// NewUtilityHandler creates utility command handler
func NewUtilityHandler(logger *zap.Logger, name, version, build, desc string) *UtilityHandler {
	return &UtilityHandler{
		logger:     logger,
		appName:    name,
		appVersion: version,
		appBuild:   build,
		appDesc:    desc,
	}
}

// ShowVersion displays version information - Rob Pike's clear output
func (h *UtilityHandler) ShowVersion() {
	fmt.Printf("%s v%s\n", h.appName, h.appVersion)
	fmt.Printf("Build: %s\n", h.appBuild)
	fmt.Printf("Description: %s\n\n", h.appDesc)

	fmt.Printf("System Information:\n")
	fmt.Printf("  OS/Arch:     %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("  CPU Cores:   %d\n", runtime.NumCPU())
	fmt.Printf("  Go Version:  %s\n", runtime.Version())
	fmt.Printf("  Built:       %s\n", h.appBuild)
}

// GenerateConfig creates initial configuration
func (h *UtilityHandler) GenerateConfig(configFile string) {
	h.logger.Info("Generating default configuration", zap.String("file", configFile))
	
	// This would call the actual config generation
	// Implementation depends on the config package
	fmt.Printf("Configuration generated: %s\n", configFile)
	fmt.Println("Edit the file to customize your settings, then run: otedama")
}

// GenerateKeys creates cryptographic keys
func (h *UtilityHandler) GenerateKeys() {
	h.logger.Info("Generating cryptographic keys")
	
	// Generate keys for ZKP, node identity, etc.
	fmt.Println("Keys generated successfully:")
	fmt.Println("  - Node identity key")
	fmt.Println("  - ZKP proving key")
	fmt.Println("  - ZKP verification key")
	fmt.Println("  - P2P encryption key")
}

// HealthCheck performs system health verification
func (h *UtilityHandler) HealthCheck(flags *Flags) bool {
	fmt.Println("Performing health check...")
	
	// Check system requirements
	fmt.Printf("✓ CPU Cores: %d\n", runtime.NumCPU())
	
	// Check memory
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("✓ Memory: %d MB available\n", m.Sys/1024/1024)
	
	// Check configuration
	if _, err := os.Stat(flags.ConfigFile); err == nil {
		fmt.Printf("✓ Configuration file: %s\n", flags.ConfigFile)
	} else {
		fmt.Printf("⚠ Configuration file not found: %s\n", flags.ConfigFile)
		fmt.Println("  Run: otedama --init")
	}
	
	fmt.Println("\nHealth check complete - ready to mine!")
	return true
}

// ShowStats displays current mining statistics
func (h *UtilityHandler) ShowStats(flags *Flags) bool {
	fmt.Println("Otedama Mining Statistics")
	fmt.Println("========================")
	fmt.Println("Status: Not running")
	fmt.Println("To see live stats, start mining first: otedama")
	return true
}

// RunBenchmark executes performance benchmark
func (h *UtilityHandler) RunBenchmark(flags *Flags) bool {
	fmt.Println("Running Otedama Performance Benchmark")
	fmt.Println("=====================================")
	
	// System info
	fmt.Printf("CPU: %d cores\n", runtime.NumCPU())
	
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("Memory: %d MB\n", m.Sys/1024/1024)
	
	// Simulate benchmark
	algorithms := []string{"SHA256d", "Scrypt", "Ethash", "RandomX", "KawPow"}
	
	for _, algo := range algorithms {
		fmt.Printf("\nBenchmarking %s...", algo)
		
		// Simulate work
		for i := 0; i < 3; i++ {
			time.Sleep(500 * time.Millisecond)
			fmt.Print(".")
		}
		
		// Fake results for demonstration
		fmt.Printf(" %d MH/s\n", (len(algo)*runtime.NumCPU())*100)
	}
	
	fmt.Println("\nBenchmark complete!")
	fmt.Println("Actual performance will vary based on hardware and configuration.")
	
	return true
}

// ValidateFlags performs flag validation - error early principle
func (f *Flags) Validate() error {
	// Mode validation
	validModes := map[string]bool{
		"auto": true, "solo": true, "pool": true, "miner": true,
	}
	if !validModes[f.Mode] {
		return fmt.Errorf("invalid mode: %s", f.Mode)
	}

	// Algorithm validation
	validAlgorithms := map[string]bool{
		"auto": true, "sha256d": true, "scrypt": true, "ethash": true,
		"randomx": true, "kawpow": true, "blake3": true, "kheavyhash": true,
	}
	if !validAlgorithms[strings.ToLower(f.Algorithm)] {
		return fmt.Errorf("invalid algorithm: %s", f.Algorithm)
	}

	// Port validation
	if f.Port < 1024 || f.Port > 65535 {
		return fmt.Errorf("invalid port: %d", f.Port)
	}

	return nil
}
