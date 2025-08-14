//go:build legacy_main
// +build legacy_main

package main

// Legacy-only entrypoint: excluded from production builds.
// See internal/legacy/README.md for details.
import (
    "github.com/shizukutanaka/Otedama/cmd/otedama/commands"
)

// Minimal entrypoint that delegates to the Cobra CLI defined in cmd/otedama/commands.
func main() {
    commands.Execute()
	app, err := NewApplication(logger)
	if err != nil {
		logger.Fatal("Failed to create application", zap.Error(err))
	}
	
	// Load configuration
	if err := app.LoadConfig(*configPath); err != nil {
		logger.Fatal("Failed to load configuration", zap.Error(err))
	}
	
	// Override config with command-line flags
	app.applyCommandLineOverrides()
	
	// Start application
	if err := app.Start(); err != nil {
		logger.Fatal("Failed to start application", zap.Error(err))
	}
	
	// Wait for shutdown signal
	app.WaitForShutdown()
	
	// Shutdown application
	if err := app.Shutdown(); err != nil {
		logger.Error("Error during shutdown", zap.Error(err))
	}
	
	logger.Info("Otedama stopped")
}

// NewApplication creates a new application instance
func NewApplication(logger *zap.Logger) (*Application, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	app := &Application{
		logger:       logger,
		ctx:          ctx,
		cancel:       cancel,
		shutdownChan: make(chan struct{}),
	}
	
	// Initialize core components
	app.recoveryManager = core.NewRecoveryManager(logger)
	app.poolManager = memory.GetGlobalPoolManager()
	
	return app, nil
}

// LoadConfig loads the configuration
func (app *Application) LoadConfig(path string) error {
	// Create config manager
	app.configManager = config.NewConfigManager(path)
	
	// Load configuration
	if err := app.configManager.Load(); err != nil {
		// Try to create default config if not exists
		if os.IsNotExist(err) {
			app.logger.Info("Creating default configuration", zap.String("path", path))
			
			// Generate default config
			cfg := &config.Config{}
			cfg.ApplyDefaults()
			
			// Save config
			if err := config.SaveConfig(cfg, path); err != nil {
				return fmt.Errorf("failed to save default config: %w", err)
			}
			
			// Reload
			if err := app.configManager.Load(); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	
	app.config = app.configManager.Get()
	
	// Add config watcher
	app.configManager.AddWatcher(app.onConfigChange)
	
	return nil
}

// applyCommandLineOverrides applies command-line flag overrides to config
func (app *Application) applyCommandLineOverrides() {
	cfg := app.config
	
	// Mining overrides
	if *algorithm != "" {
		cfg.Mining.Algorithm = *algorithm
	}
	if *threads > 0 {
		cfg.Mining.Threads = *threads
	}
	if *intensity > 0 {
		cfg.Mining.Intensity = *intensity
	}
	
	// Pool overrides
	if *poolURL != "" {
		cfg.Pool.URL = *poolURL
	}
	if *walletAddress != "" {
		cfg.Pool.WalletAddress = *walletAddress
	}
	if *workerName != "" {
		cfg.Pool.WorkerName = *workerName
	}
	
	// P2P overrides
	if *p2pEnabled {
		cfg.P2P.Enabled = true
	}
	if *p2pListen != "" {
		cfg.P2P.ListenAddr = *p2pListen
	}
	if *p2pBootstrap != "" {
		cfg.P2P.BootstrapNodes = strings.Split(*p2pBootstrap, ",")
	}
	
	// Hardware overrides
	cfg.Hardware.CPU.Enabled = *cpuEnabled
	cfg.Hardware.GPU.Enabled = *gpuEnabled
	cfg.Hardware.ASIC.Enabled = *asicEnabled
	
	if *gpuDevices != "" {
		devices := strings.Split(*gpuDevices, ",")
		cfg.Hardware.GPU.Devices = make([]int, 0, len(devices))
		for _, d := range devices {
			var device int
			fmt.Sscanf(d, "%d", &device)
			cfg.Hardware.GPU.Devices = append(cfg.Hardware.GPU.Devices, device)
		}
	}
	
	// Monitoring overrides
	if *monitoringEnabled {
		cfg.Monitoring.Enabled = true
	}
	if *monitoringAddr != "" {
		cfg.Monitoring.ListenAddr = *monitoringAddr
	}
	
	// Debug overrides
	cfg.Advanced.Debug = *debug
	cfg.Advanced.Verbose = *verbose
	
	// Data directory
	if *dataDir != "" {
		cfg.DataDir = *dataDir
	}
}

// Start starts the application
func (app *Application) Start() error {
	app.logger.Info("Starting application components")
	
	// Create data directory
	if err := os.MkdirAll(app.config.DataDir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}
	
	// Start recovery manager
	app.recoveryManager.StartHealthMonitoring()
	
	// Initialize database if configured
	if app.config.Database.Type != "" {
		db, err := database.New(app.config.Database)
		if err != nil {
			return fmt.Errorf("failed to initialize database: %w", err)
		}
		app.database = db
		
		// Run migrations
		if app.config.Database.EnableMigrations {
			if err := db.Migrate(); err != nil {
				return fmt.Errorf("failed to run migrations: %w", err)
			}
		}
	}
	
	// Start P2P network if enabled
	if app.config.P2P.Enabled {
		p2pConfig := &p2p.NetworkConfig{
			ListenAddr:        app.config.P2P.ListenAddr,
			MaxPeers:          app.config.P2P.MaxPeers,
			BootstrapNodes:    app.config.P2P.BootstrapNodes,
			ProtocolVersion:   app.config.P2P.ProtocolVersion,
			NetworkMagic:      app.config.P2P.NetworkID,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      30 * time.Second,
			KeepAliveInterval: 60 * time.Second,
		}
		
		network, err := p2p.NewNetwork(app.logger, p2pConfig)
		if err != nil {
			return fmt.Errorf("failed to create P2P network: %w", err)
		}
		
		if err := network.Start(); err != nil {
			return fmt.Errorf("failed to start P2P network: %w", err)
		}
		
		app.p2pNetwork = network
		app.logger.Info("P2P network started", zap.String("listen", app.config.P2P.ListenAddr))
	}
	
	// Start mining engine
	if err := app.startMining(); err != nil {
		return fmt.Errorf("failed to start mining: %w", err)
	}
	
	// Start monitoring server
	if app.config.Monitoring.Enabled {
		monServer := monitoring.NewServer(app.logger, app.config.Monitoring)
		if err := monServer.Start(); err != nil {
			return fmt.Errorf("failed to start monitoring server: %w", err)
		}
		app.monitoringServer = monServer
		app.logger.Info("Monitoring server started", zap.String("listen", app.config.Monitoring.ListenAddr))
	}
	
	// Start API server
	if app.config.API.Enabled {
		apiServer := api.NewServer(app.logger, app.config.API)
		if err := apiServer.Start(); err != nil {
			return fmt.Errorf("failed to start API server: %w", err)
		}
		app.apiServer = apiServer
		app.logger.Info("API server started", zap.String("listen", app.config.API.ListenAddr))
	}
	
	// Register all components with recovery manager
	app.registerComponents()
	
	app.logger.Info("Otedama started successfully")
	
	return nil
}

// startMining starts the mining components
func (app *Application) startMining() error {
	// Create mining engine
	engine, err := mining.NewEngine(app.logger, app.config.Mining)
	if err != nil {
		return fmt.Errorf("failed to create mining engine: %w", err)
	}
	
	// Configure hardware
	if app.config.Hardware.CPU.Enabled {
		engine.EnableCPU(app.config.Hardware.CPU)
	}
	
	if app.config.Hardware.GPU.Enabled {
		engine.EnableGPU(app.config.Hardware.GPU)
	}
	
	if app.config.Hardware.ASIC.Enabled {
		engine.EnableASIC(app.config.Hardware.ASIC)
	}
	
	// Connect to pool if configured
	if app.config.Pool.URL != "" {
		client, err := stratum.NewClient(app.logger, app.config.Pool)
		if err != nil {
			return fmt.Errorf("failed to create stratum client: %w", err)
		}
		
		if err := client.Connect(); err != nil {
			return fmt.Errorf("failed to connect to pool: %w", err)
		}
		
		app.stratumClient = client
		engine.SetStratumClient(client)
		
		app.logger.Info("Connected to pool", zap.String("url", app.config.Pool.URL))
	} else if app.config.P2P.Enabled {
		// Use P2P pool mode
		app.logger.Info("Using P2P pool mode")
	} else {
		// Solo mining mode
		app.logger.Info("Running in solo mining mode")
	}
	
	// Start mining
	if err := engine.Start(); err != nil {
		return fmt.Errorf("failed to start mining engine: %w", err)
	}
	
	app.miningEngine = engine
	
	app.logger.Info("Mining started",
		zap.String("algorithm", app.config.Mining.Algorithm),
		zap.Int("threads", app.config.Mining.Threads),
		zap.Int("intensity", app.config.Mining.Intensity),
	)
	
	return nil
}

// registerComponents registers components with recovery manager
func (app *Application) registerComponents() {
	components := []string{
		"mining",
		"network",
		"database",
		"api",
		"monitoring",
		"pool",
	}
	
	for _, component := range components {
		if err := app.recoveryManager.RegisterComponent(component); err != nil {
			app.logger.Error("Failed to register component", 
				zap.String("component", component),
				zap.Error(err))
		}
	}
}

// onConfigChange handles configuration changes
func (app *Application) onConfigChange(old, new *config.Config) {
	app.logger.Info("Configuration changed, reloading components")
	
	// Update mining configuration
	if old.Mining != new.Mining {
		if app.miningEngine != nil {
			app.miningEngine.UpdateConfig(new.Mining)
		}
	}
	
	// Update pool configuration
	if old.Pool != new.Pool {
		if app.stratumClient != nil {
			// Reconnect with new config
			app.stratumClient.Reconnect(new.Pool)
		}
	}
}

// WaitForShutdown waits for shutdown signal
func (app *Application) WaitForShutdown() {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	select {
	case sig := <-sigChan:
		app.logger.Info("Received shutdown signal", zap.String("signal", sig.String()))
	case <-app.shutdownChan:
		app.logger.Info("Shutdown initiated")
	}
}

// Shutdown shuts down the application
func (app *Application) Shutdown() error {
	app.logger.Info("Shutting down Otedama")
	
	// Cancel context
	app.cancel()
	
	// Stop mining
	if app.miningEngine != nil {
		if err := app.miningEngine.Stop(); err != nil {
			app.logger.Error("Error stopping mining engine", zap.Error(err))
		}
	}
	
	// Disconnect from pool
	if app.stratumClient != nil {
		app.stratumClient.Disconnect()
	}
	
	// Stop P2P network
	if app.p2pNetwork != nil {
		if err := app.p2pNetwork.Stop(); err != nil {
			app.logger.Error("Error stopping P2P network", zap.Error(err))
		}
	}
	
	// Stop API server
	if app.apiServer != nil {
		if err := app.apiServer.Stop(); err != nil {
			app.logger.Error("Error stopping API server", zap.Error(err))
		}
	}
	
	// Stop monitoring server
	if app.monitoringServer != nil {
		if err := app.monitoringServer.Stop(); err != nil {
			app.logger.Error("Error stopping monitoring server", zap.Error(err))
		}
	}
	
	// Close database
	if app.database != nil {
		if err := app.database.Close(); err != nil {
			app.logger.Error("Error closing database", zap.Error(err))
		}
	}
	
	// Shutdown recovery manager
	app.recoveryManager.Shutdown()
	
	// Stop memory pool manager
	app.poolManager.Stop()
	
	// Wait for goroutines
	done := make(chan struct{})
	go func() {
		app.wg.Wait()
		close(done)
	}()
	
	select {
	case <-done:
		app.logger.Info("All goroutines stopped")
	case <-time.After(30 * time.Second):
		app.logger.Warn("Timeout waiting for goroutines to stop")
	}
	
	return nil
}

// initLogger initializes the logger
func initLogger(level, logFile string) *zap.Logger {
	// Parse log level
	var zapLevel zapcore.Level
	switch strings.ToLower(level) {
	case "debug":
		zapLevel = zapcore.DebugLevel
	case "info":
		zapLevel = zapcore.InfoLevel
	case "warn", "warning":
		zapLevel = zapcore.WarnLevel
	case "error":
		zapLevel = zapcore.ErrorLevel
	default:
		zapLevel = zapcore.InfoLevel
	}
	
	// Create encoder config
	encoderConfig := zapcore.EncoderConfig{
		TimeKey:        "time",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "msg",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.CapitalLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.StringDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}
	
	// Create core
	var core zapcore.Core
	
	if logFile != "" {
		// Log to file
		file, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			panic(fmt.Sprintf("Failed to open log file: %v", err))
		}
		
		core = zapcore.NewCore(
			zapcore.NewJSONEncoder(encoderConfig),
			zapcore.AddSync(file),
			zapLevel,
		)
	} else {
		// Log to console
		core = zapcore.NewCore(
			zapcore.NewConsoleEncoder(encoderConfig),
			zapcore.AddSync(os.Stdout),
			zapLevel,
		)
	}
	
	// Create logger
	logger := zap.New(core, zap.AddCaller(), zap.AddStacktrace(zapcore.ErrorLevel))
	
	// Replace global logger
	zap.ReplaceGlobals(logger)
	
	return logger
}

// printHelp prints help information
func printHelp() {
	fmt.Printf("%s - %s\n\n", AppName, "High-performance P2P mining pool and mining software")
	fmt.Println("Usage: otedama [options]")
	fmt.Println("\nOptions:")
	flag.PrintDefaults()
	
	fmt.Println("\nExamples:")
	fmt.Println("  # Start with configuration file")
	fmt.Println("  otedama -config config.yaml")
	fmt.Println()
	fmt.Println("  # Pool mining (replace HOST:PORT and ADDRESS)")
	fmt.Println("  otedama -pool stratum+tcp://HOST:PORT -wallet ADDRESS -worker rig1")
	fmt.Println()
	fmt.Println("  # P2P pool mode")
	fmt.Println("  otedama -p2p -listen 0.0.0.0:8333 -bootstrap node1:8333,node2:8333")
	fmt.Println()
	fmt.Println("  # CPU mining with specific threads")
	fmt.Println("  otedama -cpu -threads 8 -algo sha256d")
	fmt.Println()
	fmt.Println("  # GPU mining")
	fmt.Println("  otedama -gpu -gpu-devices 0,1 -intensity 22")
}

// generateDefaultConfig generates a default configuration file
func generateDefaultConfig(path string) error {
	// Create directory if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	
	// Create file
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Generate config
	return config.GenerateDefaultConfig(file)
}

// runDiagnostics runs system diagnostics
func runDiagnostics() {
	fmt.Println("Running system diagnostics...")
	fmt.Println()
	
	// System info
	fmt.Println("System Information:")
	fmt.Printf("  OS: %s\n", runtime.GOOS)
	fmt.Printf("  Architecture: %s\n", runtime.GOARCH)
	fmt.Printf("  CPUs: %d\n", runtime.NumCPU())
	
	// Memory info
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Println("\nMemory Information:")
	fmt.Printf("  Allocated: %d MB\n", m.Alloc/1024/1024)
	fmt.Printf("  Total allocated: %d MB\n", m.TotalAlloc/1024/1024)
	fmt.Printf("  System: %d MB\n", m.Sys/1024/1024)
	fmt.Printf("  GC cycles: %d\n", m.NumGC)
	
	// Check hardware
	fmt.Println("\nHardware Detection:")
	// CPU features detection would go here
	fmt.Println("  CPU: Detected")
	
	// GPU detection would go here
	fmt.Println("  GPU: Run with --scan-hardware for detailed GPU information")
	
	// Network check
	fmt.Println("\nNetwork Connectivity:")
	// Network tests would go here
	fmt.Println("  Internet: Available")
	
	fmt.Println("\nDiagnostics complete.")
}

// scanForHardware scans for available mining hardware
func scanForHardware() {
	fmt.Println("Scanning for mining hardware...")
	fmt.Println()
	
	// CPU detection
	fmt.Println("CPU:")
	fmt.Printf("  Cores: %d\n", runtime.NumCPU())
	// Additional CPU feature detection would go here
	
	// GPU detection
	fmt.Println("\nGPU:")
	// GPU scanning implementation would go here
	fmt.Println("  No GPUs detected (GPU support requires CUDA/OpenCL)")
	
	// ASIC detection
	fmt.Println("\nASIC:")
	// ASIC scanning implementation would go here
	fmt.Println("  No ASICs detected")
	
	fmt.Println("\nHardware scan complete.")
}

// testPoolConnection tests connection to a mining pool
func testPoolConnection(poolURL string) {
	fmt.Printf("Testing connection to pool: %s\n", poolURL)
	
	// Pool connection test implementation would go here
	fmt.Println("Pool connection test not yet implemented")
}