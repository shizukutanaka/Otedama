package testing

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
)

// TestRunner executes test suites with proper categorization and reporting
type TestRunner struct {
	logger      *zap.Logger
	config      *TestConfig
	environment *TestEnvironment
	results     *TestResults
	filters     *TestFilters
	reporter    TestReporter
	mu          sync.RWMutex
}

// TestResults stores test execution results
type TestResults struct {
	StartTime    time.Time              `json:"start_time"`
	EndTime      time.Time              `json:"end_time"`
	Duration     time.Duration          `json:"duration"`
	Total        int                    `json:"total"`
	Passed       int                    `json:"passed"`
	Failed       int                    `json:"failed"`
	Skipped      int                    `json:"skipped"`
	Suites       map[string]*SuiteResult `json:"suites"`
	Coverage     *CoverageInfo          `json:"coverage,omitempty"`
	Performance  *PerformanceInfo       `json:"performance,omitempty"`
}

// SuiteResult stores results for a test suite
type SuiteResult struct {
	Name        string                 `json:"name"`
	StartTime   time.Time              `json:"start_time"`
	EndTime     time.Time              `json:"end_time"`
	Duration    time.Duration          `json:"duration"`
	Total       int                    `json:"total"`
	Passed      int                    `json:"passed"`
	Failed      int                    `json:"failed"`
	Skipped     int                    `json:"skipped"`
	Tests       map[string]*TestResult `json:"tests"`
	SetupError  error                  `json:"setup_error,omitempty"`
	TeardownError error                `json:"teardown_error,omitempty"`
}

// TestResult stores results for an individual test
type TestResult struct {
	Name      string        `json:"name"`
	StartTime time.Time     `json:"start_time"`
	EndTime   time.Time     `json:"end_time"`
	Duration  time.Duration `json:"duration"`
	Status    TestStatus    `json:"status"`
	Error     error         `json:"error,omitempty"`
	Output    string        `json:"output,omitempty"`
	Metadata  *TestMetadata `json:"metadata,omitempty"`
}

// TestStatus represents test execution status
type TestStatus string

const (
	StatusPassed  TestStatus = "passed"
	StatusFailed  TestStatus = "failed"
	StatusSkipped TestStatus = "skipped"
	StatusTimeout TestStatus = "timeout"
)

// CoverageInfo stores code coverage information
type CoverageInfo struct {
	Percentage float64            `json:"percentage"`
	Files      map[string]float64 `json:"files"`
	Lines      int                `json:"lines_covered"`
	Total      int                `json:"lines_total"`
}

// PerformanceInfo stores performance metrics
type PerformanceInfo struct {
	MemoryUsage    uint64            `json:"memory_usage"`
	CPUUsage       float64           `json:"cpu_usage"`
	GoroutineCount int               `json:"goroutine_count"`
	GCCount        uint32            `json:"gc_count"`
	BenchmarkResults map[string]*BenchmarkResult `json:"benchmark_results,omitempty"`
}

// BenchmarkResult stores benchmark test results
type BenchmarkResult struct {
	Name         string        `json:"name"`
	Iterations   int           `json:"iterations"`
	NsPerOp      int64         `json:"ns_per_op"`
	BytesPerOp   int64         `json:"bytes_per_op"`
	AllocsPerOp  int64         `json:"allocs_per_op"`
	MemoryBytes  int64         `json:"memory_bytes"`
	Duration     time.Duration `json:"duration"`
}

// TestFilters defines filters for test execution
type TestFilters struct {
	Categories   []string `json:"categories"`
	Tags         []string `json:"tags"`
	Patterns     []string `json:"patterns"`
	ExcludeSlowTests bool  `json:"exclude_slow_tests"`
	ExcludeIntegrationTests bool `json:"exclude_integration_tests"`
	RequiredHardware []string `json:"required_hardware"`
}

// TestReporter interface for test result reporting
type TestReporter interface {
	StartSuite(suite *TestSuite) error
	EndSuite(suite *TestSuite, result *SuiteResult) error
	StartTest(test *TestCase) error
	EndTest(test *TestCase, result *TestResult) error
	FinalReport(results *TestResults) error
}

// ConsoleReporter provides console output for test results
type ConsoleReporter struct {
	logger  *zap.Logger
	verbose bool
}

// NewConsoleReporter creates a new console reporter
func NewConsoleReporter(logger *zap.Logger, verbose bool) *ConsoleReporter {
	return &ConsoleReporter{
		logger:  logger,
		verbose: verbose,
	}
}

// StartSuite reports suite start
func (cr *ConsoleReporter) StartSuite(suite *TestSuite) error {
	if cr.verbose {
		cr.logger.Info("Starting test suite",
			zap.String("suite", suite.Name),
			zap.String("description", suite.Description))
	}
	return nil
}

// EndSuite reports suite completion
func (cr *ConsoleReporter) EndSuite(suite *TestSuite, result *SuiteResult) error {
	cr.logger.Info("Completed test suite",
		zap.String("suite", suite.Name),
		zap.Duration("duration", result.Duration),
		zap.Int("total", result.Total),
		zap.Int("passed", result.Passed),
		zap.Int("failed", result.Failed),
		zap.Int("skipped", result.Skipped))
	return nil
}

// StartTest reports test start
func (cr *ConsoleReporter) StartTest(test *TestCase) error {
	if cr.verbose {
		cr.logger.Debug("Starting test", zap.String("test", test.Name))
	}
	return nil
}

// EndTest reports test completion
func (cr *ConsoleReporter) EndTest(test *TestCase, result *TestResult) error {
	level := zap.InfoLevel
	if result.Status == StatusFailed {
		level = zap.ErrorLevel
	}
	
	cr.logger.Log(level, "Test completed",
		zap.String("test", test.Name),
		zap.String("status", string(result.Status)),
		zap.Duration("duration", result.Duration))
	
	if result.Error != nil {
		cr.logger.Error("Test error", zap.Error(result.Error))
	}
	
	return nil
}

// FinalReport reports final test results
func (cr *ConsoleReporter) FinalReport(results *TestResults) error {
	successRate := float64(results.Passed) / float64(results.Total) * 100
	
	cr.logger.Info("Test execution completed",
		zap.Duration("total_duration", results.Duration),
		zap.Int("total_tests", results.Total),
		zap.Int("passed", results.Passed),
		zap.Int("failed", results.Failed),
		zap.Int("skipped", results.Skipped),
		zap.Float64("success_rate", successRate))
	
	if results.Coverage != nil {
		cr.logger.Info("Code coverage",
			zap.Float64("percentage", results.Coverage.Percentage),
			zap.Int("lines_covered", results.Coverage.Lines),
			zap.Int("lines_total", results.Coverage.Total))
	}
	
	if results.Performance != nil {
		cr.logger.Info("Performance metrics",
			zap.Uint64("memory_usage", results.Performance.MemoryUsage),
			zap.Float64("cpu_usage", results.Performance.CPUUsage),
			zap.Int("goroutines", results.Performance.GoroutineCount))
	}
	
	return nil
}

// NewTestRunner creates a new test runner
func NewTestRunner(logger *zap.Logger, env *TestEnvironment) *TestRunner {
	return &TestRunner{
		logger:      logger,
		config:      env.Config,
		environment: env,
		results: &TestResults{
			Suites: make(map[string]*SuiteResult),
		},
		filters:  &TestFilters{},
		reporter: NewConsoleReporter(logger, true),
	}
}

// SetFilters sets test execution filters
func (tr *TestRunner) SetFilters(filters *TestFilters) {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.filters = filters
}

// SetReporter sets the test reporter
func (tr *TestRunner) SetReporter(reporter TestReporter) {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.reporter = reporter
}

// RunSuite executes a test suite
func (tr *TestRunner) RunSuite(suite *TestSuite) (*SuiteResult, error) {
	if !tr.shouldRunSuite(suite) {
		tr.logger.Info("Skipping test suite", zap.String("suite", suite.Name))
		return nil, nil
	}
	
	result := &SuiteResult{
		Name:      suite.Name,
		StartTime: time.Now(),
		Tests:     make(map[string]*TestResult),
	}
	
	if tr.reporter != nil {
		tr.reporter.StartSuite(suite)
	}
	
	// Suite setup
	if suite.Setup != nil {
		if err := suite.Setup(); err != nil {
			result.SetupError = err
			tr.logger.Error("Suite setup failed",
				zap.String("suite", suite.Name),
				zap.Error(err))
			return result, err
		}
	}
	
	// Run tests
	for _, test := range suite.Tests {
		if tr.shouldRunTest(&test, suite) {
			testResult := tr.runTest(&test, suite)
			result.Tests[test.Name] = testResult
			result.Total++
			
			switch testResult.Status {
			case StatusPassed:
				result.Passed++
			case StatusFailed:
				result.Failed++
			case StatusSkipped:
				result.Skipped++
			}
		} else {
			result.Total++
			result.Skipped++
		}
	}
	
	// Suite teardown
	if suite.Teardown != nil {
		if err := suite.Teardown(); err != nil {
			result.TeardownError = err
			tr.logger.Error("Suite teardown failed",
				zap.String("suite", suite.Name),
				zap.Error(err))
		}
	}
	
	result.EndTime = time.Now()
	result.Duration = result.EndTime.Sub(result.StartTime)
	
	if tr.reporter != nil {
		tr.reporter.EndSuite(suite, result)
	}
	
	tr.mu.Lock()
	tr.results.Suites[suite.Name] = result
	tr.mu.Unlock()
	
	return result, nil
}

// runTest executes an individual test
func (tr *TestRunner) runTest(test *TestCase, suite *TestSuite) *TestResult {
	result := &TestResult{
		Name:      test.Name,
		StartTime: time.Now(),
		Status:    StatusPassed,
	}
	
	if tr.reporter != nil {
		tr.reporter.StartTest(test)
	}
	
	// Create test framework
	tf := NewTestFramework(&testing.T{}) // Mock testing.T for standalone execution
	defer tf.Cleanup()
	
	// Setup timeout
	timeout := tr.config.DefaultTimeout
	if suite.Metadata != nil && suite.Metadata.Timeout > 0 {
		timeout = suite.Metadata.Timeout
	}
	
	ctx, cancel := context.WithTimeout(tf.Ctx, timeout)
	defer cancel()
	
	// Execute test with timeout
	done := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("test panicked: %v", r)
			}
		}()
		
		// Test setup
		if test.Setup != nil {
			test.Setup(tf)
		}
		
		// Test execution
		var err error
		if test.Execute != nil {
			err = test.Execute(tf)
		}
		
		// Test assertions
		if test.Assert != nil {
			test.Assert(tf, err)
		}
		
		// Test cleanup
		if test.Cleanup != nil {
			test.Cleanup(tf)
		}
		
		done <- err
	}()
	
	select {
	case err := <-done:
		if err != nil {
			result.Status = StatusFailed
			result.Error = err
		}
	case <-ctx.Done():
		result.Status = StatusTimeout
		result.Error = fmt.Errorf("test timed out after %v", timeout)
	}
	
	result.EndTime = time.Now()
	result.Duration = result.EndTime.Sub(result.StartTime)
	
	if tr.reporter != nil {
		tr.reporter.EndTest(test, result)
	}
	
	return result
}

// shouldRunSuite determines if a suite should be executed
func (tr *TestRunner) shouldRunSuite(suite *TestSuite) bool {
	if tr.filters == nil {
		return true
	}
	
	// Check category filter
	if len(tr.filters.Categories) > 0 {
		if suite.Metadata == nil || !contains(tr.filters.Categories, suite.Metadata.Category) {
			return false
		}
	}
	
	// Check integration test filter
	if tr.filters.ExcludeIntegrationTests && suite.Metadata != nil {
		if suite.Metadata.Category == "integration" || contains(suite.Metadata.Tags, "integration") {
			return false
		}
	}
	
	// Check slow test filter
	if tr.filters.ExcludeSlowTests && suite.Metadata != nil {
		if contains(suite.Metadata.Tags, "slow") {
			return false
		}
	}
	
	// Check hardware requirements
	if len(tr.filters.RequiredHardware) > 0 && suite.Metadata != nil {
		for _, req := range suite.Metadata.Requirements {
			if strings.Contains(req, "gpu") || strings.Contains(req, "asic") {
				if !contains(tr.filters.RequiredHardware, req) {
					return false
				}
			}
		}
	}
	
	return true
}

// shouldRunTest determines if a test should be executed
func (tr *TestRunner) shouldRunTest(test *TestCase, suite *TestSuite) bool {
	if tr.filters == nil {
		return true
	}
	
	// Check pattern filter
	if len(tr.filters.Patterns) > 0 {
		matched := false
		for _, pattern := range tr.filters.Patterns {
			if strings.Contains(test.Name, pattern) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	
	return true
}

// RunAll executes all test suites
func (tr *TestRunner) RunAll(suites []*TestSuite) (*TestResults, error) {
	tr.results.StartTime = time.Now()
	
	// Collect performance baseline
	var startMem runtime.MemStats
	runtime.ReadMemStats(&startMem)
	startGoroutines := runtime.NumGoroutine()
	
	for _, suite := range suites {
		result, err := tr.RunSuite(suite)
		if err != nil {
			tr.logger.Error("Suite execution failed",
				zap.String("suite", suite.Name),
				zap.Error(err))
		}
		
		if result != nil {
			tr.results.Total += result.Total
			tr.results.Passed += result.Passed
			tr.results.Failed += result.Failed
			tr.results.Skipped += result.Skipped
		}
	}
	
	tr.results.EndTime = time.Now()
	tr.results.Duration = tr.results.EndTime.Sub(tr.results.StartTime)
	
	// Collect final performance metrics
	var endMem runtime.MemStats
	runtime.ReadMemStats(&endMem)
	endGoroutines := runtime.NumGoroutine()
	
	tr.results.Performance = &PerformanceInfo{
		MemoryUsage:    endMem.Alloc - startMem.Alloc,
		GoroutineCount: endGoroutines - startGoroutines,
		GCCount:        endMem.NumGC - startMem.NumGC,
	}
	
	if tr.reporter != nil {
		tr.reporter.FinalReport(tr.results)
	}
	
	return tr.results, nil
}

// DiscoverTests discovers test suites in a directory
func DiscoverTests(rootDir string) ([]*TestSuite, error) {
	var suites []*TestSuite
	
	err := filepath.Walk(rootDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		if strings.HasSuffix(path, "_test.go") {
			// Parse test file and create suite
			// This is a simplified implementation
			suite := NewTestSuite(
				filepath.Base(strings.TrimSuffix(path, "_test.go")),
				fmt.Sprintf("Tests from %s", path),
			)
			suites = append(suites, suite)
		}
		
		return nil
	})
	
	return suites, err
}

// Helper functions

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}