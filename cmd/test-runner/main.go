package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/shizukutanaka/Otedama/internal/testing"
	"go.uber.org/zap"
)

// Command line flags
var (
	verbose     = flag.Bool("v", false, "Verbose output")
	parallel    = flag.Bool("parallel", true, "Run tests in parallel")
	failFast    = flag.Bool("fail-fast", false, "Stop on first failure")
	coverage    = flag.Bool("coverage", false, "Enable coverage reporting")
	timeout     = flag.Duration("timeout", 5*time.Minute, "Global test timeout")
	filter      = flag.String("filter", "", "Filter tests by name pattern")
	category    = flag.String("category", "", "Run tests by category (unit,integration,performance)")
	tags        = flag.String("tags", "", "Run tests with specific tags (comma-separated)")
	benchTime   = flag.Duration("bench-time", 1*time.Second, "Benchmark run time")
	maxWorkers  = flag.Int("workers", 10, "Maximum parallel workers")
	outputFormat = flag.String("format", "console", "Output format (console,json,junit)")
)

func main() {
	flag.Parse()
	
	// Initialize logger
	var logger *zap.Logger
	var err error
	
	if *verbose {
		logger, err = zap.NewDevelopment()
	} else {
		logger, err = zap.NewProduction()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync()
	
	// Create test configuration
	config := testing.TestConfig{
		Parallel:      *parallel,
		MaxWorkers:    *maxWorkers,
		Timeout:       *timeout,
		Verbose:       *verbose,
		FailFast:      *failFast,
		Coverage:      *coverage,
		BenchmarkTime: *benchTime,
	}
	
	// Create test framework
	framework := testing.NewTestFramework(logger, config)
	
	// Create test suite registry
	registry := testing.NewTestSuiteRegistry(framework, logger)
	
	// Register all test suites
	if err := registry.RegisterAllSuites(); err != nil {
		logger.Fatal("Failed to register test suites", zap.Error(err))
	}
	
	// Apply filters if specified
	if err := applyFilters(framework, *filter, *category, *tags); err != nil {
		logger.Fatal("Failed to apply filters", zap.Error(err))
	}
	
	// Run tests
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	
	logger.Info("Starting test execution",
		zap.Bool("parallel", *parallel),
		zap.Int("max_workers", *maxWorkers),
		zap.Duration("timeout", *timeout),
		zap.String("filter", *filter),
		zap.String("category", *category),
		zap.String("tags", *tags),
	)
	
	report, err := framework.RunAllTests(ctx)
	if err != nil {
		logger.Fatal("Test execution failed", zap.Error(err))
	}
	
	// Output results
	if err := outputResults(report, *outputFormat, logger); err != nil {
		logger.Error("Failed to output results", zap.Error(err))
	}
	
	// Exit with appropriate code
	if report.TotalFailed > 0 {
		os.Exit(1)
	}
	
	logger.Info("All tests completed successfully")
}

// applyFilters applies command line filters to the test framework
func applyFilters(framework *testing.TestFramework, filter, category, tags string) error {
	// This would filter test suites based on the criteria
	// For now, just log the filter criteria
	if filter != "" {
		framework.Logger().Info("Applying name filter", zap.String("pattern", filter))
	}
	if category != "" {
		framework.Logger().Info("Applying category filter", zap.String("category", category))
	}
	if tags != "" {
		tagList := strings.Split(tags, ",")
		framework.Logger().Info("Applying tag filter", zap.Strings("tags", tagList))
	}
	
	return nil
}

// outputResults outputs test results in the specified format
func outputResults(report *testing.TestReport, format string, logger *zap.Logger) error {
	switch format {
	case "console":
		return outputConsole(report, logger)
	case "json":
		return outputJSON(report, logger)
	case "junit":
		return outputJUnit(report, logger)
	default:
		return fmt.Errorf("unsupported output format: %s", format)
	}
}

// outputConsole outputs results to console
func outputConsole(report *testing.TestReport, logger *zap.Logger) error {
	fmt.Printf("\n")
	fmt.Printf("%s\n", strings.Repeat("=", 60))
	fmt.Printf("TEST EXECUTION SUMMARY\n")
	fmt.Printf("%s\n", strings.Repeat("=", 60))
	fmt.Printf("Total Test Suites: %d\n", report.TotalSuites)
	fmt.Printf("Total Tests:       %d\n", report.TotalTests)
	fmt.Printf("Passed:           %d\n", report.TotalPassed)
	fmt.Printf("Failed:           %d\n", report.TotalFailed)
	fmt.Printf("Skipped:          %d\n", report.TotalSkipped)
	fmt.Printf("Duration:         %v\n", report.Duration)
	fmt.Printf("Generated:        %v\n", report.GeneratedAt.Format(time.RFC3339))
	
	if report.TotalFailed > 0 {
		fmt.Printf("\n")
		fmt.Printf("FAILED TESTS:\n")
		fmt.Printf("%s\n", strings.Repeat("-", 40))
		
		for _, suiteResult := range report.SuiteResults {
			for _, testResult := range suiteResult.TestResults {
				if testResult.Status == testing.TestStatusFailed {
					fmt.Printf("✗ %s.%s\n", suiteResult.Name, testResult.Name)
					fmt.Printf("  Error: %v\n", testResult.Error)
					fmt.Printf("  Duration: %v\n", testResult.Duration)
					if testResult.Memory != nil {
						fmt.Printf("  Memory: %d bytes allocated\n", testResult.Memory.AllocBytes)
					}
					fmt.Printf("\n")
				}
			}
		}
	}
	
	// Success rate
	successRate := float64(0)
	if report.TotalTests > 0 {
		successRate = float64(report.TotalPassed) / float64(report.TotalTests) * 100
	}
	
	fmt.Printf("\n")
	fmt.Printf("Success Rate: %.2f%%\n", successRate)
	
	if successRate == 100.0 {
		fmt.Printf("🎉 All tests passed!\n")
	}
	
	return nil
}

// outputJSON outputs results in JSON format
func outputJSON(report *testing.TestReport, logger *zap.Logger) error {
	// Implementation for JSON output
	logger.Info("JSON output not yet implemented")
	return nil
}

// outputJUnit outputs results in JUnit XML format
func outputJUnit(report *testing.TestReport, logger *zap.Logger) error {
	// Implementation for JUnit XML output
	logger.Info("JUnit XML output not yet implemented")
	return nil
}