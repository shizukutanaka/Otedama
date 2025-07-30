package deployment

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// Pipeline represents a deployment pipeline
// Following Rob Pike's principle: "Make it work, make it right, make it fast"
type Pipeline struct {
	logger *zap.Logger
	name   string
	
	// Pipeline stages
	stages   []*Stage
	stageMap map[string]*Stage
	
	// Execution state
	status     PipelineStatus
	statusLock sync.RWMutex
	
	// Configuration
	config *PipelineConfig
	
	// Artifacts
	artifacts *ArtifactManager
}

// PipelineConfig contains pipeline configuration
type PipelineConfig struct {
	// Pipeline settings
	Name               string
	Description        string
	Timeout            time.Duration
	MaxRetries         int
	ParallelExecution  bool
	
	// Triggers
	TriggerOnPush      bool
	TriggerOnTag       bool
	TriggerBranches    []string
	TriggerSchedule    string // Cron expression
	
	// Notifications
	NotifyOnSuccess    bool
	NotifyOnFailure    bool
	NotificationWebhook string
	
	// Environment
	EnvironmentVars    map[string]string
	Secrets            map[string]string
}

// Stage represents a pipeline stage
type Stage struct {
	Name          string
	Description   string
	Type          StageType
	Dependencies  []string
	Jobs          []*Job
	Condition     StageCondition
	RetryPolicy   *RetryPolicy
	Timeout       time.Duration
}

// StageType defines the type of stage
type StageType string

const (
	StageTypeBuild   StageType = "build"
	StageTypeTest    StageType = "test"
	StageTypeDeploy  StageType = "deploy"
	StageTypeRelease StageType = "release"
	StageTypeCustom  StageType = "custom"
)

// Job represents a job within a stage
type Job struct {
	Name        string
	Script      []string
	Image       string // Docker image for job
	Artifacts   []string
	Cache       []string
	Environment map[string]string
	Timeout     time.Duration
}

// StageCondition defines when a stage should run
type StageCondition struct {
	OnSuccess   bool
	OnFailure   bool
	OnChange    []string // Run if these files changed
	Expression  string   // Custom condition expression
}

// RetryPolicy defines retry behavior
type RetryPolicy struct {
	MaxAttempts int
	Backoff     time.Duration
	Exponential bool
}

// PipelineStatus represents pipeline execution status
type PipelineStatus struct {
	ID          string
	Status      string
	StartTime   time.Time
	EndTime     time.Time
	Duration    time.Duration
	Stages      map[string]*StageStatus
	Artifacts   []string
	Error       error
}

// StageStatus represents stage execution status
type StageStatus struct {
	Name      string
	Status    string
	StartTime time.Time
	EndTime   time.Time
	Jobs      map[string]*JobStatus
	Error     error
}

// JobStatus represents job execution status
type JobStatus struct {
	Name      string
	Status    string
	StartTime time.Time
	EndTime   time.Time
	ExitCode  int
	Output    string
	Error     error
}

// NewPipeline creates a new deployment pipeline
func NewPipeline(name string, logger *zap.Logger, config *PipelineConfig) *Pipeline {
	if config == nil {
		config = DefaultPipelineConfig()
	}
	
	return &Pipeline{
		logger:    logger,
		name:      name,
		stages:    make([]*Stage, 0),
		stageMap:  make(map[string]*Stage),
		config:    config,
		artifacts: NewArtifactManager(logger),
	}
}

// AddStage adds a stage to the pipeline
func (p *Pipeline) AddStage(stage *Stage) error {
	if _, exists := p.stageMap[stage.Name]; exists {
		return fmt.Errorf("stage %s already exists", stage.Name)
	}
	
	p.stages = append(p.stages, stage)
	p.stageMap[stage.Name] = stage
	
	return nil
}

// Execute runs the pipeline
func (p *Pipeline) Execute(ctx context.Context) error {
	p.logger.Info("Starting pipeline execution",
		zap.String("pipeline", p.name),
		zap.Int("stages", len(p.stages)),
	)
	
	// Initialize status
	p.updateStatus(PipelineStatus{
		ID:        generatePipelineID(),
		Status:    "running",
		StartTime: time.Now(),
		Stages:    make(map[string]*StageStatus),
	})
	
	// Execute stages
	for _, stage := range p.stages {
		if err := p.executeStage(ctx, stage); err != nil {
			p.handleError(err)
			return err
		}
	}
	
	// Success
	p.statusLock.Lock()
	p.status.Status = "success"
	p.status.EndTime = time.Now()
	p.status.Duration = p.status.EndTime.Sub(p.status.StartTime)
	p.statusLock.Unlock()
	
	p.logger.Info("Pipeline execution completed",
		zap.String("pipeline", p.name),
		zap.Duration("duration", p.status.Duration),
	)
	
	return nil
}

// GetStatus returns current pipeline status
func (p *Pipeline) GetStatus() PipelineStatus {
	p.statusLock.RLock()
	defer p.statusLock.RUnlock()
	return p.status
}

// Private methods

func (p *Pipeline) executeStage(ctx context.Context, stage *Stage) error {
	p.logger.Info("Executing stage",
		zap.String("stage", stage.Name),
		zap.String("type", string(stage.Type)),
	)
	
	// Check dependencies
	if err := p.checkDependencies(stage); err != nil {
		return fmt.Errorf("dependency check failed: %w", err)
	}
	
	// Check condition
	if !p.shouldRunStage(stage) {
		p.logger.Info("Skipping stage due to condition",
			zap.String("stage", stage.Name),
		)
		return nil
	}
	
	// Initialize stage status
	stageStatus := &StageStatus{
		Name:      stage.Name,
		Status:    "running",
		StartTime: time.Now(),
		Jobs:      make(map[string]*JobStatus),
	}
	
	p.statusLock.Lock()
	p.status.Stages[stage.Name] = stageStatus
	p.statusLock.Unlock()
	
	// Execute jobs
	var jobErr error
	if p.config.ParallelExecution && len(stage.Jobs) > 1 {
		jobErr = p.executeJobsParallel(ctx, stage, stageStatus)
	} else {
		jobErr = p.executeJobsSequential(ctx, stage, stageStatus)
	}
	
	// Update stage status
	stageStatus.EndTime = time.Now()
	if jobErr != nil {
		stageStatus.Status = "failed"
		stageStatus.Error = jobErr
		return jobErr
	}
	
	stageStatus.Status = "success"
	return nil
}

func (p *Pipeline) executeJobsSequential(ctx context.Context, stage *Stage, stageStatus *StageStatus) error {
	for _, job := range stage.Jobs {
		if err := p.executeJob(ctx, job, stageStatus); err != nil {
			return err
		}
	}
	return nil
}

func (p *Pipeline) executeJobsParallel(ctx context.Context, stage *Stage, stageStatus *StageStatus) error {
	var wg sync.WaitGroup
	errorCh := make(chan error, len(stage.Jobs))
	
	for _, job := range stage.Jobs {
		wg.Add(1)
		go func(j *Job) {
			defer wg.Done()
			if err := p.executeJob(ctx, j, stageStatus); err != nil {
				errorCh <- err
			}
		}(job)
	}
	
	wg.Wait()
	close(errorCh)
	
	// Check for errors
	for err := range errorCh {
		if err != nil {
			return err
		}
	}
	
	return nil
}

func (p *Pipeline) executeJob(ctx context.Context, job *Job, stageStatus *StageStatus) error {
	p.logger.Info("Executing job", zap.String("job", job.Name))
	
	jobStatus := &JobStatus{
		Name:      job.Name,
		Status:    "running",
		StartTime: time.Now(),
	}
	
	stageStatus.Jobs[job.Name] = jobStatus
	
	// Execute job script
	// In production, would use container runtime or remote execution
	for _, cmd := range job.Script {
		p.logger.Debug("Running command", zap.String("cmd", cmd))
		// Simplified execution
		time.Sleep(100 * time.Millisecond)
	}
	
	jobStatus.EndTime = time.Now()
	jobStatus.Status = "success"
	jobStatus.ExitCode = 0
	
	return nil
}

func (p *Pipeline) checkDependencies(stage *Stage) error {
	for _, dep := range stage.Dependencies {
		depStage, exists := p.stageMap[dep]
		if !exists {
			return fmt.Errorf("dependency stage %s not found", dep)
		}
		
		// Check if dependency completed successfully
		p.statusLock.RLock()
		depStatus, exists := p.status.Stages[dep]
		p.statusLock.RUnlock()
		
		if !exists || depStatus.Status != "success" {
			return fmt.Errorf("dependency stage %s not completed successfully", dep)
		}
		
		_ = depStage // Use the variable
	}
	return nil
}

func (p *Pipeline) shouldRunStage(stage *Stage) bool {
	// Check stage condition
	if stage.Condition.Expression != "" {
		// Evaluate custom expression
		// Simplified for now
		return true
	}
	
	// Check file changes if specified
	if len(stage.Condition.OnChange) > 0 {
		// Would check git diff in production
		return true
	}
	
	return true
}

func (p *Pipeline) handleError(err error) {
	p.statusLock.Lock()
	p.status.Status = "failed"
	p.status.Error = err
	p.status.EndTime = time.Now()
	p.status.Duration = p.status.EndTime.Sub(p.status.StartTime)
	p.statusLock.Unlock()
	
	p.logger.Error("Pipeline execution failed",
		zap.String("pipeline", p.name),
		zap.Error(err),
	)
}

func (p *Pipeline) updateStatus(status PipelineStatus) {
	p.statusLock.Lock()
	defer p.statusLock.Unlock()
	p.status = status
}

// ArtifactManager manages pipeline artifacts
type ArtifactManager struct {
	logger    *zap.Logger
	artifacts map[string]*Artifact
	mu        sync.RWMutex
}

type Artifact struct {
	Name      string
	Path      string
	Size      int64
	Checksum  string
	CreatedAt time.Time
}

func NewArtifactManager(logger *zap.Logger) *ArtifactManager {
	return &ArtifactManager{
		logger:    logger,
		artifacts: make(map[string]*Artifact),
	}
}

func (am *ArtifactManager) Store(name, path string) error {
	am.logger.Debug("Storing artifact",
		zap.String("name", name),
		zap.String("path", path),
	)
	
	artifact := &Artifact{
		Name:      name,
		Path:      path,
		CreatedAt: time.Now(),
	}
	
	am.mu.Lock()
	am.artifacts[name] = artifact
	am.mu.Unlock()
	
	return nil
}

// CreateStandardPipeline creates a standard CI/CD pipeline
func CreateStandardPipeline(logger *zap.Logger) *Pipeline {
	pipeline := NewPipeline("standard-pipeline", logger, nil)
	
	// Build stage
	buildStage := &Stage{
		Name:        "build",
		Description: "Build Otedama binary",
		Type:        StageTypeBuild,
		Jobs: []*Job{
			{
				Name: "compile",
				Script: []string{
					"go mod download",
					"go build -o otedama ./cmd/otedama",
				},
				Artifacts: []string{"otedama"},
			},
		},
	}
	
	// Test stage
	testStage := &Stage{
		Name:         "test",
		Description:  "Run tests",
		Type:         StageTypeTest,
		Dependencies: []string{"build"},
		Jobs: []*Job{
			{
				Name: "unit-tests",
				Script: []string{
					"go test -race ./...",
				},
			},
			{
				Name: "integration-tests",
				Script: []string{
					"go test -tags=integration ./...",
				},
			},
		},
	}
	
	// Deploy stage
	deployStage := &Stage{
		Name:         "deploy",
		Description:  "Deploy to production",
		Type:         StageTypeDeploy,
		Dependencies: []string{"test"},
		Condition: StageCondition{
			OnSuccess: true,
		},
		Jobs: []*Job{
			{
				Name: "deploy-production",
				Script: []string{
					"./scripts/deploy.sh production",
				},
			},
		},
	}
	
	// Add stages to pipeline
	pipeline.AddStage(buildStage)
	pipeline.AddStage(testStage)
	pipeline.AddStage(deployStage)
	
	return pipeline
}

// Helper functions

func generatePipelineID() string {
	return fmt.Sprintf("pipeline_%d", time.Now().Unix())
}

// DefaultPipelineConfig returns default pipeline configuration
func DefaultPipelineConfig() *PipelineConfig {
	return &PipelineConfig{
		Name:              "default-pipeline",
		Timeout:           30 * time.Minute,
		MaxRetries:        2,
		ParallelExecution: true,
		TriggerOnPush:     true,
		TriggerOnTag:      true,
		NotifyOnSuccess:   false,
		NotifyOnFailure:   true,
		EnvironmentVars:   make(map[string]string),
		Secrets:           make(map[string]string),
	}
}