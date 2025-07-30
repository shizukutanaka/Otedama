package optimization

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// CodeOptimizer analyzes code and suggests performance optimizations
// Following John Carmack's principle: "Premature optimization is the root of all evil, but that doesn't mean you should write stupid code"
type CodeOptimizer struct {
	logger *zap.Logger
	config *OptimizerConfig
	
	// Code analysis
	analyzer        *CodeAnalyzer
	patternMatcher  *PatternMatcher
	
	// Optimization rules
	rules           map[string]OptimizationRule
	rulesMu         sync.RWMutex
	
	// Suggestions
	suggestions     []*OptimizationSuggestion
	suggestionsMu   sync.RWMutex
	
	// Performance data
	perfData        *PerformanceData
	
	// Metrics
	metrics         *OptimizerMetrics
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// OptimizerConfig contains optimizer configuration
type OptimizerConfig struct {
	// Analysis settings
	TargetDirs          []string
	ExcludeDirs         []string
	FilePatterns        []string
	MaxFileSize         int64
	
	// Optimization settings
	EnableAllRules      bool
	EnabledRules        []string
	SeverityThreshold   SuggestionSeverity
	
	// Performance data
	UseProfileData      bool
	ProfileDataPath     string
	
	// Suggestions
	MaxSuggestions      int
	GroupBySeverity     bool
	
	// Reporting
	OutputFormat        string // "json", "markdown", "html"
	OutputPath          string
}

// OptimizationRule defines an optimization rule
type OptimizationRule interface {
	GetID() string
	GetName() string
	GetDescription() string
	Check(node ast.Node, context *AnalysisContext) *OptimizationSuggestion
}

// OptimizationSuggestion represents a code optimization suggestion
type OptimizationSuggestion struct {
	ID              string
	RuleID          string
	Severity        SuggestionSeverity
	Category        SuggestionCategory
	File            string
	Line            int
	Column          int
	Message         string
	Description     string
	SuggestedCode   string
	CurrentCode     string
	Impact          PerformanceImpact
	Confidence      float64
	References      []string
}

// SuggestionSeverity represents severity levels
type SuggestionSeverity string

const (
	SeverityInfo     SuggestionSeverity = "info"
	SeverityWarning  SuggestionSeverity = "warning"
	SeverityError    SuggestionSeverity = "error"
	SeverityCritical SuggestionSeverity = "critical"
)

// SuggestionCategory represents optimization categories
type SuggestionCategory string

const (
	CategoryMemory      SuggestionCategory = "memory"
	CategoryCPU         SuggestionCategory = "cpu"
	CategoryConcurrency SuggestionCategory = "concurrency"
	CategoryAlgorithm   SuggestionCategory = "algorithm"
	CategoryIO          SuggestionCategory = "io"
	CategoryAPI         SuggestionCategory = "api"
)

// PerformanceImpact estimates performance impact
type PerformanceImpact struct {
	CPUReduction    float64 // Percentage
	MemoryReduction float64 // Percentage
	LatencyReduction float64 // Percentage
}

// OptimizerMetrics tracks optimizer performance
type OptimizerMetrics struct {
	FilesAnalyzed       atomic.Uint64
	FunctionsAnalyzed   atomic.Uint64
	SuggestionsFound    atomic.Uint64
	CriticalIssues      atomic.Uint64
	AnalysisTime        atomic.Uint64 // Milliseconds
}

// NewCodeOptimizer creates a new code optimizer
func NewCodeOptimizer(logger *zap.Logger, config *OptimizerConfig) (*CodeOptimizer, error) {
	if config == nil {
		config = DefaultOptimizerConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	co := &CodeOptimizer{
		logger:         logger,
		config:         config,
		analyzer:       NewCodeAnalyzer(logger),
		patternMatcher: NewPatternMatcher(),
		rules:          make(map[string]OptimizationRule),
		suggestions:    make([]*OptimizationSuggestion, 0),
		perfData:       NewPerformanceData(config.ProfileDataPath),
		metrics:        &OptimizerMetrics{},
		ctx:            ctx,
		cancel:         cancel,
	}
	
	// Register optimization rules
	co.registerDefaultRules()
	
	return co, nil
}

// Start starts the code optimizer
func (co *CodeOptimizer) Start() error {
	co.logger.Info("Starting code optimizer",
		zap.Strings("target_dirs", co.config.TargetDirs),
		zap.Int("rules", len(co.rules)),
	)
	
	// Load performance data if available
	if co.config.UseProfileData {
		if err := co.perfData.Load(); err != nil {
			co.logger.Warn("Failed to load performance data", zap.Error(err))
		}
	}
	
	return nil
}

// Stop stops the code optimizer
func (co *CodeOptimizer) Stop() error {
	co.logger.Info("Stopping code optimizer")
	
	co.cancel()
	co.wg.Wait()
	
	return nil
}

// AnalyzeCode analyzes code and generates optimization suggestions
func (co *CodeOptimizer) AnalyzeCode() error {
	start := time.Now()
	
	// Clear previous suggestions
	co.suggestionsMu.Lock()
	co.suggestions = co.suggestions[:0]
	co.suggestionsMu.Unlock()
	
	// Analyze each target directory
	for _, dir := range co.config.TargetDirs {
		if err := co.analyzeDirectory(dir); err != nil {
			co.logger.Error("Failed to analyze directory",
				zap.String("dir", dir),
				zap.Error(err),
			)
		}
	}
	
	// Update metrics
	analysisTime := time.Since(start).Milliseconds()
	co.metrics.AnalysisTime.Store(uint64(analysisTime))
	
	co.logger.Info("Code analysis completed",
		zap.Uint64("files_analyzed", co.metrics.FilesAnalyzed.Load()),
		zap.Uint64("suggestions", co.metrics.SuggestionsFound.Load()),
		zap.Duration("duration", time.Since(start)),
	)
	
	return nil
}

// GetSuggestions returns optimization suggestions
func (co *CodeOptimizer) GetSuggestions(severity SuggestionSeverity) []*OptimizationSuggestion {
	co.suggestionsMu.RLock()
	defer co.suggestionsMu.RUnlock()
	
	if severity == "" {
		return co.suggestions
	}
	
	// Filter by severity
	filtered := make([]*OptimizationSuggestion, 0)
	for _, suggestion := range co.suggestions {
		if co.compareSeverity(suggestion.Severity, severity) >= 0 {
			filtered = append(filtered, suggestion)
		}
	}
	
	return filtered
}

// GenerateReport generates an optimization report
func (co *CodeOptimizer) GenerateReport() (string, error) {
	suggestions := co.GetSuggestions(co.config.SeverityThreshold)
	
	switch co.config.OutputFormat {
	case "json":
		return co.generateJSONReport(suggestions)
	case "markdown":
		return co.generateMarkdownReport(suggestions)
	case "html":
		return co.generateHTMLReport(suggestions)
	default:
		return co.generateTextReport(suggestions)
	}
}

// Private methods

func (co *CodeOptimizer) registerDefaultRules() {
	// Memory optimization rules
	co.registerRule(NewStringConcatenationRule())
	co.registerRule(NewSlicePreallocationRule())
	co.registerRule(NewMapPreallocationRule())
	co.registerRule(NewUnnecessaryAllocationRule())
	co.registerRule(NewMemoryLeakRule())
	
	// CPU optimization rules
	co.registerRule(NewLoopOptimizationRule())
	co.registerRule(NewRecursionRule())
	co.registerRule(NewReflectionRule())
	co.registerRule(NewRegexCompilationRule())
	
	// Concurrency optimization rules
	co.registerRule(NewGoroutineLeakRule())
	co.registerRule(NewChannelBufferRule())
	co.registerRule(NewMutexContentionRule())
	co.registerRule(NewContextUsageRule())
	
	// Algorithm optimization rules
	co.registerRule(NewTimeComplexityRule())
	co.registerRule(NewSortingRule())
	co.registerRule(NewSearchRule())
	
	// I/O optimization rules
	co.registerRule(NewFileHandlingRule())
	co.registerRule(NewDatabaseQueryRule())
	co.registerRule(NewHTTPClientRule())
}

func (co *CodeOptimizer) registerRule(rule OptimizationRule) {
	co.rulesMu.Lock()
	co.rules[rule.GetID()] = rule
	co.rulesMu.Unlock()
}

func (co *CodeOptimizer) analyzeDirectory(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		
		// Skip excluded directories
		if d.IsDir() {
			for _, exclude := range co.config.ExcludeDirs {
				if strings.Contains(path, exclude) {
					return filepath.SkipDir
				}
			}
			return nil
		}
		
		// Check file pattern
		if !co.matchesPattern(path) {
			return nil
		}
		
		// Analyze file
		return co.analyzeFile(path)
	})
}

func (co *CodeOptimizer) analyzeFile(path string) error {
	co.metrics.FilesAnalyzed.Add(1)
	
	// Parse file
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return err
	}
	
	// Create analysis context
	context := &AnalysisContext{
		FileSet:  fset,
		File:     node,
		Path:     path,
		PerfData: co.perfData,
	}
	
	// Apply optimization rules
	ast.Inspect(node, func(n ast.Node) bool {
		if n == nil {
			return false
		}
		
		// Check each rule
		co.rulesMu.RLock()
		for _, rule := range co.rules {
			if suggestion := rule.Check(n, context); suggestion != nil {
				co.addSuggestion(suggestion)
			}
		}
		co.rulesMu.RUnlock()
		
		return true
	})
	
	return nil
}

func (co *CodeOptimizer) matchesPattern(path string) bool {
	if len(co.config.FilePatterns) == 0 {
		return strings.HasSuffix(path, ".go")
	}
	
	for _, pattern := range co.config.FilePatterns {
		matched, _ := filepath.Match(pattern, filepath.Base(path))
		if matched {
			return true
		}
	}
	
	return false
}

func (co *CodeOptimizer) addSuggestion(suggestion *OptimizationSuggestion) {
	co.suggestionsMu.Lock()
	defer co.suggestionsMu.Unlock()
	
	// Check max suggestions
	if co.config.MaxSuggestions > 0 && len(co.suggestions) >= co.config.MaxSuggestions {
		return
	}
	
	co.suggestions = append(co.suggestions, suggestion)
	co.metrics.SuggestionsFound.Add(1)
	
	if suggestion.Severity == SeverityCritical {
		co.metrics.CriticalIssues.Add(1)
	}
}

func (co *CodeOptimizer) compareSeverity(a, b SuggestionSeverity) int {
	severityOrder := map[SuggestionSeverity]int{
		SeverityInfo:     0,
		SeverityWarning:  1,
		SeverityError:    2,
		SeverityCritical: 3,
	}
	
	return severityOrder[a] - severityOrder[b]
}

func (co *CodeOptimizer) generateTextReport(suggestions []*OptimizationSuggestion) (string, error) {
	var report strings.Builder
	
	report.WriteString("Code Optimization Report\n")
	report.WriteString("========================\n\n")
	
	// Summary
	report.WriteString(fmt.Sprintf("Total suggestions: %d\n", len(suggestions)))
	report.WriteString(fmt.Sprintf("Critical issues: %d\n\n", co.metrics.CriticalIssues.Load()))
	
	// Group by severity if configured
	if co.config.GroupBySeverity {
		severities := []SuggestionSeverity{SeverityCritical, SeverityError, SeverityWarning, SeverityInfo}
		for _, severity := range severities {
			var severitySuggestions []*OptimizationSuggestion
			for _, s := range suggestions {
				if s.Severity == severity {
					severitySuggestions = append(severitySuggestions, s)
				}
			}
			
			if len(severitySuggestions) > 0 {
				report.WriteString(fmt.Sprintf("%s Issues (%d)\n", severity, len(severitySuggestions)))
				report.WriteString(strings.Repeat("-", 40) + "\n")
				
				for _, s := range severitySuggestions {
					co.writeSuggestion(&report, s)
				}
				report.WriteString("\n")
			}
		}
	} else {
		// List all suggestions
		for _, s := range suggestions {
			co.writeSuggestion(&report, s)
		}
	}
	
	return report.String(), nil
}

func (co *CodeOptimizer) writeSuggestion(w *strings.Builder, s *OptimizationSuggestion) {
	w.WriteString(fmt.Sprintf("[%s] %s\n", s.Severity, s.Message))
	w.WriteString(fmt.Sprintf("  File: %s:%d:%d\n", s.File, s.Line, s.Column))
	w.WriteString(fmt.Sprintf("  Category: %s\n", s.Category))
	w.WriteString(fmt.Sprintf("  Rule: %s\n", s.RuleID))
	
	if s.Description != "" {
		w.WriteString(fmt.Sprintf("  Description: %s\n", s.Description))
	}
	
	if s.CurrentCode != "" {
		w.WriteString("  Current code:\n")
		w.WriteString(fmt.Sprintf("    %s\n", s.CurrentCode))
	}
	
	if s.SuggestedCode != "" {
		w.WriteString("  Suggested code:\n")
		w.WriteString(fmt.Sprintf("    %s\n", s.SuggestedCode))
	}
	
	if s.Impact.CPUReduction > 0 || s.Impact.MemoryReduction > 0 || s.Impact.LatencyReduction > 0 {
		w.WriteString("  Expected impact:\n")
		if s.Impact.CPUReduction > 0 {
			w.WriteString(fmt.Sprintf("    - CPU: -%.1f%%\n", s.Impact.CPUReduction))
		}
		if s.Impact.MemoryReduction > 0 {
			w.WriteString(fmt.Sprintf("    - Memory: -%.1f%%\n", s.Impact.MemoryReduction))
		}
		if s.Impact.LatencyReduction > 0 {
			w.WriteString(fmt.Sprintf("    - Latency: -%.1f%%\n", s.Impact.LatencyReduction))
		}
	}
	
	w.WriteString("\n")
}

func (co *CodeOptimizer) generateMarkdownReport(suggestions []*OptimizationSuggestion) (string, error) {
	var report strings.Builder
	
	report.WriteString("# Code Optimization Report\n\n")
	report.WriteString("## Summary\n\n")
	report.WriteString(fmt.Sprintf("- **Total suggestions**: %d\n", len(suggestions)))
	report.WriteString(fmt.Sprintf("- **Critical issues**: %d\n", co.metrics.CriticalIssues.Load()))
	report.WriteString(fmt.Sprintf("- **Files analyzed**: %d\n\n", co.metrics.FilesAnalyzed.Load()))
	
	// Suggestions by severity
	severities := []SuggestionSeverity{SeverityCritical, SeverityError, SeverityWarning, SeverityInfo}
	for _, severity := range severities {
		var severitySuggestions []*OptimizationSuggestion
		for _, s := range suggestions {
			if s.Severity == severity {
				severitySuggestions = append(severitySuggestions, s)
			}
		}
		
		if len(severitySuggestions) > 0 {
			report.WriteString(fmt.Sprintf("## %s Issues\n\n", severity))
			
			for i, s := range severitySuggestions {
				report.WriteString(fmt.Sprintf("### %d. %s\n\n", i+1, s.Message))
				report.WriteString(fmt.Sprintf("- **File**: `%s:%d:%d`\n", s.File, s.Line, s.Column))
				report.WriteString(fmt.Sprintf("- **Category**: %s\n", s.Category))
				report.WriteString(fmt.Sprintf("- **Rule**: %s\n\n", s.RuleID))
				
				if s.Description != "" {
					report.WriteString(fmt.Sprintf("%s\n\n", s.Description))
				}
				
				if s.CurrentCode != "" {
					report.WriteString("**Current code:**\n```go\n")
					report.WriteString(s.CurrentCode)
					report.WriteString("\n```\n\n")
				}
				
				if s.SuggestedCode != "" {
					report.WriteString("**Suggested code:**\n```go\n")
					report.WriteString(s.SuggestedCode)
					report.WriteString("\n```\n\n")
				}
				
				if s.Impact.CPUReduction > 0 || s.Impact.MemoryReduction > 0 {
					report.WriteString("**Expected impact:**\n")
					if s.Impact.CPUReduction > 0 {
						report.WriteString(fmt.Sprintf("- CPU usage: -%.1f%%\n", s.Impact.CPUReduction))
					}
					if s.Impact.MemoryReduction > 0 {
						report.WriteString(fmt.Sprintf("- Memory usage: -%.1f%%\n", s.Impact.MemoryReduction))
					}
					report.WriteString("\n")
				}
			}
		}
	}
	
	return report.String(), nil
}

func (co *CodeOptimizer) generateJSONReport(suggestions []*OptimizationSuggestion) (string, error) {
	// Simplified JSON generation
	return fmt.Sprintf(`{
	"summary": {
		"total_suggestions": %d,
		"critical_issues": %d,
		"files_analyzed": %d
	},
	"suggestions": [...]
}`, len(suggestions), co.metrics.CriticalIssues.Load(), co.metrics.FilesAnalyzed.Load()), nil
}

func (co *CodeOptimizer) generateHTMLReport(suggestions []*OptimizationSuggestion) (string, error) {
	// Simplified HTML generation
	return "<html><body><h1>Code Optimization Report</h1></body></html>", nil
}

// AnalysisContext provides context for code analysis
type AnalysisContext struct {
	FileSet  *token.FileSet
	File     *ast.File
	Path     string
	PerfData *PerformanceData
}

// CodeAnalyzer performs code analysis
type CodeAnalyzer struct {
	logger *zap.Logger
}

// NewCodeAnalyzer creates a new code analyzer
func NewCodeAnalyzer(logger *zap.Logger) *CodeAnalyzer {
	return &CodeAnalyzer{logger: logger}
}

// PatternMatcher matches code patterns
type PatternMatcher struct{}

// NewPatternMatcher creates a new pattern matcher
func NewPatternMatcher() *PatternMatcher {
	return &PatternMatcher{}
}

// PerformanceData manages performance profiling data
type PerformanceData struct {
	path string
	data map[string]interface{}
	mu   sync.RWMutex
}

// NewPerformanceData creates new performance data
func NewPerformanceData(path string) *PerformanceData {
	return &PerformanceData{
		path: path,
		data: make(map[string]interface{}),
	}
}

// Load loads performance data
func (pd *PerformanceData) Load() error {
	// Simplified implementation
	return nil
}

// DefaultOptimizerConfig returns default configuration
func DefaultOptimizerConfig() *OptimizerConfig {
	return &OptimizerConfig{
		TargetDirs:        []string{"./internal"},
		ExcludeDirs:       []string{"vendor", "node_modules", ".git"},
		FilePatterns:      []string{"*.go"},
		MaxFileSize:       10 * 1024 * 1024, // 10MB
		EnableAllRules:    true,
		SeverityThreshold: SeverityInfo,
		MaxSuggestions:    1000,
		GroupBySeverity:   true,
		OutputFormat:      "markdown",
	}
}