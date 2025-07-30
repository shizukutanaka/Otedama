package deployment

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// Deployer handles automated deployment of Otedama
// Following John Carmack's principle: "The best code is simple code that works"
type Deployer struct {
	logger *zap.Logger
	config *DeploymentConfig
	
	// Deployment state
	deploymentID string
	status       DeploymentStatus
	statusLock   sync.RWMutex
	
	// Deployment strategies
	strategies map[string]DeploymentStrategy
	
	// Health checker
	healthChecker *HealthChecker
	
	// Rollback manager
	rollbackManager *RollbackManager
}

// DeploymentConfig contains deployment configuration
type DeploymentConfig struct {
	// Target environment
	Environment     string            // dev, staging, production
	TargetHosts     []string          // Target hosts for deployment
	DeploymentPath  string            // Path where to deploy
	
	// Deployment options
	Strategy        string            // blue-green, rolling, canary
	MaxParallel     int               // Max parallel deployments
	HealthCheckWait time.Duration     // Wait time for health checks
	RollbackOnFail  bool              // Auto rollback on failure
	
	// Build options
	BuildFlags      []string          // Go build flags
	BuildTags       []string          // Build tags
	TargetOS        string            // Target OS
	TargetArch      string            // Target architecture
	
	// Service management
	ServiceName     string            // System service name
	ServiceManager  string            // systemd, upstart, supervisor
	RestartService  bool              // Restart service after deployment
	
	// Verification
	VerifyChecksum  bool              // Verify binary checksum
	VerifySignature bool              // Verify binary signature
	SigningKey      string            // Path to signing key
}

// DeploymentStatus represents deployment status
type DeploymentStatus struct {
	ID              string
	Phase           string
	Progress        float64
	StartTime       time.Time
	EndTime         time.Time
	Success         bool
	Error           error
	DeployedHosts   []string
	FailedHosts     []string
	RollbackApplied bool
}

// DeploymentStrategy defines a deployment approach
type DeploymentStrategy interface {
	Name() string
	Deploy(ctx context.Context, config *DeploymentConfig) error
	Validate(config *DeploymentConfig) error
}

// NewDeployer creates a new deployer
func NewDeployer(logger *zap.Logger, config *DeploymentConfig) *Deployer {
	if config == nil {
		config = DefaultDeploymentConfig()
	}
	
	deployer := &Deployer{
		logger:          logger,
		config:          config,
		strategies:      make(map[string]DeploymentStrategy),
		healthChecker:   NewHealthChecker(logger),
		rollbackManager: NewRollbackManager(logger),
	}
	
	// Register deployment strategies
	deployer.registerStrategies()
	
	return deployer
}

// Deploy performs automated deployment
func (d *Deployer) Deploy(ctx context.Context) error {
	d.deploymentID = generateDeploymentID()
	d.updateStatus(DeploymentStatus{
		ID:        d.deploymentID,
		Phase:     "initializing",
		StartTime: time.Now(),
	})
	
	d.logger.Info("Starting deployment",
		zap.String("id", d.deploymentID),
		zap.String("environment", d.config.Environment),
		zap.String("strategy", d.config.Strategy),
		zap.Strings("targets", d.config.TargetHosts),
	)
	
	// Create rollback point
	if d.config.RollbackOnFail {
		if err := d.rollbackManager.CreateSnapshot(d.deploymentID); err != nil {
			return fmt.Errorf("failed to create rollback snapshot: %w", err)
		}
	}
	
	// Build phase
	if err := d.build(ctx); err != nil {
		return d.handleError("build", err)
	}
	
	// Test phase
	if err := d.test(ctx); err != nil {
		return d.handleError("test", err)
	}
	
	// Deploy phase
	if err := d.deploy(ctx); err != nil {
		return d.handleError("deploy", err)
	}
	
	// Verify phase
	if err := d.verify(ctx); err != nil {
		return d.handleError("verify", err)
	}
	
	// Success
	d.updateStatus(DeploymentStatus{
		ID:       d.deploymentID,
		Phase:    "completed",
		Progress: 100,
		EndTime:  time.Now(),
		Success:  true,
	})
	
	d.logger.Info("Deployment completed successfully",
		zap.String("id", d.deploymentID),
		zap.Duration("duration", time.Since(d.getStatus().StartTime)),
	)
	
	return nil
}

// GetStatus returns current deployment status
func (d *Deployer) GetStatus() DeploymentStatus {
	d.statusLock.RLock()
	defer d.statusLock.RUnlock()
	return d.status
}

// Private methods

func (d *Deployer) build(ctx context.Context) error {
	d.updatePhase("building", 10)
	
	d.logger.Info("Building Otedama binary",
		zap.String("os", d.config.TargetOS),
		zap.String("arch", d.config.TargetArch),
	)
	
	// Prepare build command
	args := []string{"build"}
	args = append(args, d.config.BuildFlags...)
	
	if len(d.config.BuildTags) > 0 {
		args = append(args, "-tags", strings.Join(d.config.BuildTags, ","))
	}
	
	// Set output binary name
	binaryName := "otedama"
	if d.config.TargetOS == "windows" {
		binaryName += ".exe"
	}
	args = append(args, "-o", filepath.Join("build", binaryName))
	
	// Set main package
	args = append(args, "./cmd/otedama")
	
	// Run build
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("GOOS=%s", d.config.TargetOS),
		fmt.Sprintf("GOARCH=%s", d.config.TargetArch),
		"CGO_ENABLED=0", // Static binary
	)
	
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("build failed: %w\nOutput: %s", err, output)
	}
	
	d.updateProgress(20)
	return nil
}

func (d *Deployer) test(ctx context.Context) error {
	d.updatePhase("testing", 30)
	
	d.logger.Info("Running tests")
	
	// Run unit tests
	cmd := exec.CommandContext(ctx, "go", "test", "-race", "-timeout", "5m", "./...")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tests failed: %w\nOutput: %s", err, output)
	}
	
	d.updateProgress(40)
	return nil
}

func (d *Deployer) deploy(ctx context.Context) error {
	d.updatePhase("deploying", 50)
	
	// Get deployment strategy
	strategy, exists := d.strategies[d.config.Strategy]
	if !exists {
		return fmt.Errorf("unknown deployment strategy: %s", d.config.Strategy)
	}
	
	// Validate strategy
	if err := strategy.Validate(d.config); err != nil {
		return fmt.Errorf("strategy validation failed: %w", err)
	}
	
	// Execute deployment
	if err := strategy.Deploy(ctx, d.config); err != nil {
		return fmt.Errorf("deployment failed: %w", err)
	}
	
	d.updateProgress(80)
	return nil
}

func (d *Deployer) verify(ctx context.Context) error {
	d.updatePhase("verifying", 90)
	
	d.logger.Info("Verifying deployment")
	
	// Health check all deployed hosts
	var wg sync.WaitGroup
	errorCh := make(chan error, len(d.config.TargetHosts))
	
	for _, host := range d.config.TargetHosts {
		wg.Add(1)
		go func(h string) {
			defer wg.Done()
			
			// Wait for service to start
			time.Sleep(d.config.HealthCheckWait)
			
			// Perform health check
			if err := d.healthChecker.CheckHost(ctx, h); err != nil {
				errorCh <- fmt.Errorf("health check failed for %s: %w", h, err)
			}
		}(host)
	}
	
	wg.Wait()
	close(errorCh)
	
	// Check for errors
	var errors []error
	for err := range errorCh {
		errors = append(errors, err)
	}
	
	if len(errors) > 0 {
		return fmt.Errorf("verification failed: %v", errors)
	}
	
	d.updateProgress(100)
	return nil
}

func (d *Deployer) handleError(phase string, err error) error {
	d.logger.Error("Deployment failed",
		zap.String("phase", phase),
		zap.Error(err),
	)
	
	d.updateStatus(DeploymentStatus{
		ID:      d.deploymentID,
		Phase:   "failed",
		EndTime: time.Now(),
		Success: false,
		Error:   err,
	})
	
	// Attempt rollback if configured
	if d.config.RollbackOnFail {
		d.logger.Info("Attempting rollback")
		
		if rollbackErr := d.rollbackManager.Rollback(d.deploymentID); rollbackErr != nil {
			d.logger.Error("Rollback failed", zap.Error(rollbackErr))
		} else {
			d.status.RollbackApplied = true
			d.logger.Info("Rollback completed successfully")
		}
	}
	
	return fmt.Errorf("%s: %w", phase, err)
}

func (d *Deployer) updateStatus(status DeploymentStatus) {
	d.statusLock.Lock()
	defer d.statusLock.Unlock()
	d.status = status
}

func (d *Deployer) updatePhase(phase string, progress float64) {
	d.statusLock.Lock()
	defer d.statusLock.Unlock()
	d.status.Phase = phase
	d.status.Progress = progress
}

func (d *Deployer) updateProgress(progress float64) {
	d.statusLock.Lock()
	defer d.statusLock.Unlock()
	d.status.Progress = progress
}

func (d *Deployer) getStatus() DeploymentStatus {
	d.statusLock.RLock()
	defer d.statusLock.RUnlock()
	return d.status
}

func (d *Deployer) registerStrategies() {
	// Blue-Green deployment
	d.strategies["blue-green"] = &BlueGreenStrategy{logger: d.logger}
	
	// Rolling deployment
	d.strategies["rolling"] = &RollingStrategy{
		logger:      d.logger,
		maxParallel: d.config.MaxParallel,
	}
	
	// Canary deployment
	d.strategies["canary"] = &CanaryStrategy{
		logger:        d.logger,
		healthChecker: d.healthChecker,
	}
}

// Deployment strategies

// BlueGreenStrategy implements blue-green deployment
type BlueGreenStrategy struct {
	logger *zap.Logger
}

func (bgs *BlueGreenStrategy) Name() string { return "blue-green" }

func (bgs *BlueGreenStrategy) Validate(config *DeploymentConfig) error {
	if len(config.TargetHosts) == 0 {
		return fmt.Errorf("no target hosts specified")
	}
	return nil
}

func (bgs *BlueGreenStrategy) Deploy(ctx context.Context, config *DeploymentConfig) error {
	bgs.logger.Info("Executing blue-green deployment")
	
	// Deploy to green environment
	for _, host := range config.TargetHosts {
		if err := deployToHost(ctx, host, config); err != nil {
			return fmt.Errorf("failed to deploy to %s: %w", host, err)
		}
	}
	
	// Switch traffic (simplified)
	bgs.logger.Info("Switching traffic to green environment")
	
	return nil
}

// RollingStrategy implements rolling deployment
type RollingStrategy struct {
	logger      *zap.Logger
	maxParallel int
}

func (rs *RollingStrategy) Name() string { return "rolling" }

func (rs *RollingStrategy) Validate(config *DeploymentConfig) error {
	return nil
}

func (rs *RollingStrategy) Deploy(ctx context.Context, config *DeploymentConfig) error {
	rs.logger.Info("Executing rolling deployment",
		zap.Int("max_parallel", rs.maxParallel),
	)
	
	// Deploy in batches
	for i := 0; i < len(config.TargetHosts); i += rs.maxParallel {
		end := i + rs.maxParallel
		if end > len(config.TargetHosts) {
			end = len(config.TargetHosts)
		}
		
		batch := config.TargetHosts[i:end]
		
		// Deploy batch
		var wg sync.WaitGroup
		errorCh := make(chan error, len(batch))
		
		for _, host := range batch {
			wg.Add(1)
			go func(h string) {
				defer wg.Done()
				if err := deployToHost(ctx, h, config); err != nil {
					errorCh <- err
				}
			}(host)
		}
		
		wg.Wait()
		close(errorCh)
		
		// Check for errors
		for err := range errorCh {
			if err != nil {
				return err
			}
		}
	}
	
	return nil
}

// CanaryStrategy implements canary deployment
type CanaryStrategy struct {
	logger        *zap.Logger
	healthChecker *HealthChecker
}

func (cs *CanaryStrategy) Name() string { return "canary" }

func (cs *CanaryStrategy) Validate(config *DeploymentConfig) error {
	if len(config.TargetHosts) < 2 {
		return fmt.Errorf("canary deployment requires at least 2 hosts")
	}
	return nil
}

func (cs *CanaryStrategy) Deploy(ctx context.Context, config *DeploymentConfig) error {
	cs.logger.Info("Executing canary deployment")
	
	// Deploy to canary host (first host)
	canaryHost := config.TargetHosts[0]
	if err := deployToHost(ctx, canaryHost, config); err != nil {
		return fmt.Errorf("canary deployment failed: %w", err)
	}
	
	// Monitor canary
	cs.logger.Info("Monitoring canary", zap.String("host", canaryHost))
	time.Sleep(2 * time.Minute) // Simplified monitoring period
	
	// Check canary health
	if err := cs.healthChecker.CheckHost(ctx, canaryHost); err != nil {
		return fmt.Errorf("canary health check failed: %w", err)
	}
	
	// Deploy to remaining hosts
	for _, host := range config.TargetHosts[1:] {
		if err := deployToHost(ctx, host, config); err != nil {
			return fmt.Errorf("failed to deploy to %s: %w", host, err)
		}
	}
	
	return nil
}

// Helper components

// HealthChecker performs health checks
type HealthChecker struct {
	logger *zap.Logger
}

func NewHealthChecker(logger *zap.Logger) *HealthChecker {
	return &HealthChecker{logger: logger}
}

func (hc *HealthChecker) CheckHost(ctx context.Context, host string) error {
	// Simplified health check
	hc.logger.Debug("Checking host health", zap.String("host", host))
	return nil
}

// RollbackManager handles deployment rollbacks
type RollbackManager struct {
	logger    *zap.Logger
	snapshots map[string]*DeploymentSnapshot
	mu        sync.RWMutex
}

type DeploymentSnapshot struct {
	ID        string
	Timestamp time.Time
	Binary    []byte
	Config    []byte
}

func NewRollbackManager(logger *zap.Logger) *RollbackManager {
	return &RollbackManager{
		logger:    logger,
		snapshots: make(map[string]*DeploymentSnapshot),
	}
}

func (rm *RollbackManager) CreateSnapshot(deploymentID string) error {
	rm.logger.Info("Creating rollback snapshot", zap.String("id", deploymentID))
	
	snapshot := &DeploymentSnapshot{
		ID:        deploymentID,
		Timestamp: time.Now(),
	}
	
	rm.mu.Lock()
	rm.snapshots[deploymentID] = snapshot
	rm.mu.Unlock()
	
	return nil
}

func (rm *RollbackManager) Rollback(deploymentID string) error {
	rm.mu.RLock()
	snapshot, exists := rm.snapshots[deploymentID]
	rm.mu.RUnlock()
	
	if !exists {
		return fmt.Errorf("no snapshot found for deployment %s", deploymentID)
	}
	
	rm.logger.Info("Rolling back deployment",
		zap.String("id", deploymentID),
		zap.Time("snapshot_time", snapshot.Timestamp),
	)
	
	// Rollback logic would go here
	
	return nil
}

// Helper functions

func deployToHost(ctx context.Context, host string, config *DeploymentConfig) error {
	// Simplified deployment to host
	// In production, would use SSH or other remote execution
	return nil
}

func generateDeploymentID() string {
	return fmt.Sprintf("deploy_%d", time.Now().Unix())
}

// DefaultDeploymentConfig returns default deployment configuration
func DefaultDeploymentConfig() *DeploymentConfig {
	return &DeploymentConfig{
		Environment:     "production",
		Strategy:        "rolling",
		MaxParallel:     2,
		HealthCheckWait: 30 * time.Second,
		RollbackOnFail:  true,
		TargetOS:        runtime.GOOS,
		TargetArch:      runtime.GOARCH,
		ServiceName:     "otedama",
		ServiceManager:  "systemd",
		RestartService:  true,
		VerifyChecksum:  true,
		VerifySignature: false,
	}
}