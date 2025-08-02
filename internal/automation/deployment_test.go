package automation

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// Mock deployment target
type mockDeploymentTarget struct {
	mock.Mock
	mu          sync.Mutex
	deployments []string
	healthy     bool
}

func (m *mockDeploymentTarget) Deploy(ctx context.Context, version string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	args := m.Called(ctx, version)
	if args.Error(0) == nil {
		m.deployments = append(m.deployments, version)
	}
	return args.Error(0)
}

func (m *mockDeploymentTarget) CheckHealth(ctx context.Context) error {
	args := m.Called(ctx)
	return args.Error(0)
}

func (m *mockDeploymentTarget) GetDeployments() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string{}, m.deployments...)
}

func TestDeploymentManager_Creation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		MaxParallel:        2,
		HealthCheckTimeout: 30 * time.Second,
		RollbackOnFailure:  true,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)
	assert.NotNil(t, dm)
}

func TestDeploymentManager_StartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:    StrategyRolling,
		MaxParallel: 2,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	// Start
	err = dm.Start()
	assert.NoError(t, err)

	// Should not start again
	err = dm.Start()
	assert.Error(t, err)

	// Stop
	err = dm.Stop()
	assert.NoError(t, err)

	// Should not stop again
	err = dm.Stop()
	assert.Error(t, err)
}

func TestDeploymentManager_RollingDeployment(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		MaxParallel:        2,
		HealthCheckTimeout: 1 * time.Second,
		RollbackOnFailure:  true,
		RollingUpdate: RollingUpdateConfig{
			MaxSurge:       1,
			MaxUnavailable: 1,
		},
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	err = dm.Start()
	require.NoError(t, err)
	defer dm.Stop()

	// Create mock targets
	targets := make([]*mockDeploymentTarget, 4)
	targetAddrs := make([]string, 4)
	for i := 0; i < 4; i++ {
		targets[i] = &mockDeploymentTarget{healthy: true}
		targetAddrs[i] = fmt.Sprintf("target-%d", i)
		
		// Setup expectations
		targets[i].On("Deploy", mock.Anything, "v1.0.0").Return(nil)
		targets[i].On("CheckHealth", mock.Anything).Return(nil)
	}

	// Mock the actual deployment logic
	ctx := context.Background()
	deploymentID, err := dm.Deploy(ctx, "v1.0.0", targetAddrs)
	assert.NoError(t, err)
	assert.NotEmpty(t, deploymentID)

	// Wait for deployment to complete
	time.Sleep(100 * time.Millisecond)

	// Check deployment info
	info := dm.GetDeploymentInfo(deploymentID)
	assert.NotNil(t, info)
	assert.Equal(t, "v1.0.0", info.Version)
}

func TestDeploymentManager_BlueGreenDeployment(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyBlueGreen,
		HealthCheckTimeout: 1 * time.Second,
		RollbackOnFailure:  true,
		BlueGreen: BlueGreenConfig{
			TestTrafficPercent: 10,
			SwitchDelay:        100 * time.Millisecond,
		},
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	err = dm.Start()
	require.NoError(t, err)
	defer dm.Stop()

	// Create blue and green environments
	blueTargets := []string{"blue-1", "blue-2"}
	greenTargets := []string{"green-1", "green-2"}

	ctx := context.Background()
	
	// Deploy to green environment
	deploymentID, err := dm.Deploy(ctx, "v2.0.0", greenTargets)
	assert.NoError(t, err)
	assert.NotEmpty(t, deploymentID)

	// Wait for deployment
	time.Sleep(200 * time.Millisecond)

	// Verify deployment status
	info := dm.GetDeploymentInfo(deploymentID)
	assert.NotNil(t, info)
	assert.Equal(t, "v2.0.0", info.Version)
}

func TestDeploymentManager_CanaryDeployment(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyCanary,
		HealthCheckTimeout: 1 * time.Second,
		RollbackOnFailure:  true,
		Canary: CanaryConfig{
			InitialPercent: 10,
			IncrementPercent: 20,
			IncrementInterval: 100 * time.Millisecond,
			AnalysisTemplate: "basic",
		},
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	err = dm.Start()
	require.NoError(t, err)
	defer dm.Stop()

	// Deploy with canary strategy
	targets := []string{"target-1", "target-2", "target-3", "target-4", "target-5"}
	
	ctx := context.Background()
	deploymentID, err := dm.Deploy(ctx, "v3.0.0", targets)
	assert.NoError(t, err)
	assert.NotEmpty(t, deploymentID)

	// Monitor canary progress
	time.Sleep(50 * time.Millisecond)
	
	info := dm.GetDeploymentInfo(deploymentID)
	assert.NotNil(t, info)
	
	// Should start with initial percentage
	progress := dm.GetCanaryProgress(deploymentID)
	assert.GreaterOrEqual(t, progress, 10)
	
	// Wait for full rollout
	time.Sleep(500 * time.Millisecond)
	
	// Should be fully deployed
	progress = dm.GetCanaryProgress(deploymentID)
	assert.Equal(t, 100, progress)
}

func TestDeploymentManager_RollbackOnFailure(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		MaxParallel:        2,
		HealthCheckTimeout: 100 * time.Millisecond,
		RollbackOnFailure:  true,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	err = dm.Start()
	require.NoError(t, err)
	defer dm.Stop()

	// Create targets where some will fail
	targets := make([]string, 4)
	for i := 0; i < 4; i++ {
		targets[i] = fmt.Sprintf("target-%d", i)
	}

	// Deploy with failures
	ctx := context.Background()
	deploymentID, err := dm.Deploy(ctx, "v-fail", targets)
	
	// Deployment should fail and trigger rollback
	if err == nil {
		// Wait for rollback
		time.Sleep(200 * time.Millisecond)
		
		info := dm.GetDeploymentInfo(deploymentID)
		assert.Equal(t, DeploymentStatusRolledBack, info.Status)
	}
}

func TestDeploymentManager_ConcurrentDeployments(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		MaxParallel:        4,
		HealthCheckTimeout: 1 * time.Second,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	err = dm.Start()
	require.NoError(t, err)
	defer dm.Stop()

	// Start multiple deployments concurrently
	var wg sync.WaitGroup
	deploymentIDs := make([]string, 3)
	errors := make([]error, 3)

	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			
			targets := []string{
				fmt.Sprintf("env%d-target1", idx),
				fmt.Sprintf("env%d-target2", idx),
			}
			
			ctx := context.Background()
			deploymentIDs[idx], errors[idx] = dm.Deploy(ctx, fmt.Sprintf("v1.%d.0", idx), targets)
		}(i)
	}

	wg.Wait()

	// All deployments should succeed
	for i, err := range errors {
		assert.NoError(t, err)
		assert.NotEmpty(t, deploymentIDs[i])
	}

	// Check that all deployments are tracked
	stats := dm.GetStats()
	assert.GreaterOrEqual(t, stats.TotalDeployments, uint64(3))
}

func TestDeploymentManager_HealthChecks(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		HealthCheckTimeout: 100 * time.Millisecond,
		HealthCheckRetries: 3,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	// Test health check with retries
	healthCheckCalls := atomic.Int32{}
	
	// Simulate health check that fails first 2 times
	mockTarget := &mockDeploymentTarget{}
	mockTarget.On("CheckHealth", mock.Anything).Return(func(ctx context.Context) error {
		count := healthCheckCalls.Add(1)
		if count < 3 {
			return fmt.Errorf("health check failed")
		}
		return nil
	})

	// Health check should eventually succeed after retries
	ctx := context.Background()
	err = dm.performHealthCheck(ctx, mockTarget)
	assert.NoError(t, err)
	assert.Equal(t, int32(3), healthCheckCalls.Load())
}

func TestDeploymentManager_Metrics(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &DeploymentConfig{
		Strategy:    StrategyRolling,
		MaxParallel: 2,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(t, err)

	err = dm.Start()
	require.NoError(t, err)
	defer dm.Stop()

	// Perform some deployments
	ctx := context.Background()
	
	// Successful deployment
	_, err = dm.Deploy(ctx, "v1.0.0", []string{"target1", "target2"})
	assert.NoError(t, err)

	// Get metrics
	stats := dm.GetStats()
	assert.Equal(t, uint64(1), stats.TotalDeployments)
	assert.Equal(t, uint64(1), stats.SuccessfulDeployments)
	assert.Equal(t, uint64(0), stats.FailedDeployments)
	assert.Equal(t, uint64(0), stats.RollbackCount)
}

// Benchmark tests

func BenchmarkDeploymentManager_Deploy(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		MaxParallel:        10,
		HealthCheckTimeout: 100 * time.Millisecond,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(b, err)

	err = dm.Start()
	require.NoError(b, err)
	defer dm.Stop()

	targets := make([]string, 10)
	for i := 0; i < 10; i++ {
		targets[i] = fmt.Sprintf("target-%d", i)
	}

	ctx := context.Background()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		version := fmt.Sprintf("v1.0.%d", i)
		dm.Deploy(ctx, version, targets)
	}
}

func BenchmarkDeploymentManager_ConcurrentDeploy(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := &DeploymentConfig{
		Strategy:           StrategyRolling,
		MaxParallel:        20,
		HealthCheckTimeout: 100 * time.Millisecond,
	}

	dm, err := NewDeploymentManager(logger, config)
	require.NoError(b, err)

	err = dm.Start()
	require.NoError(b, err)
	defer dm.Stop()

	b.ResetTimer()

	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			targets := []string{
				fmt.Sprintf("bench-target-%d-1", i),
				fmt.Sprintf("bench-target-%d-2", i),
			}
			ctx := context.Background()
			dm.Deploy(ctx, fmt.Sprintf("v1.0.%d", i), targets)
			i++
		}
	})
}