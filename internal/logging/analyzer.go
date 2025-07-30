package logging

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

// LogAnalyzer provides log analysis capabilities
// Following John Carmack's principle: "Understand your data"
type LogAnalyzer struct {
	entries []LogEntry
	filters []Filter
}

// LogEntry represents a parsed log entry
type LogEntry struct {
	Timestamp   time.Time              `json:"timestamp"`
	Level       string                 `json:"level"`
	Logger      string                 `json:"logger"`
	Message     string                 `json:"msg"`
	Caller      string                 `json:"caller,omitempty"`
	StackTrace  string                 `json:"stacktrace,omitempty"`
	Fields      map[string]interface{} `json:"-"`
	Raw         string                 `json:"-"`
}

// Filter defines a log filter
type Filter func(entry LogEntry) bool

// NewLogAnalyzer creates a new log analyzer
func NewLogAnalyzer() *LogAnalyzer {
	return &LogAnalyzer{
		entries: []LogEntry{},
		filters: []Filter{},
	}
}

// LoadFile loads and parses a log file
func (la *LogAnalyzer) LoadFile(filename string) error {
	file, err := os.Open(filename)
	if err != nil {
		return fmt.Errorf("failed to open log file: %w", err)
	}
	defer file.Close()
	
	return la.LoadReader(file)
}

// LoadReader loads logs from a reader
func (la *LogAnalyzer) LoadReader(reader io.Reader) error {
	scanner := bufio.NewScanner(reader)
	lineNum := 0
	
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()
		
		if line == "" {
			continue
		}
		
		entry, err := parseLogLine(line)
		if err != nil {
			// Store unparseable lines as raw
			entry = LogEntry{
				Timestamp: time.Now(),
				Level:     "unknown",
				Message:   line,
				Raw:       line,
			}
		}
		
		la.entries = append(la.entries, entry)
	}
	
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("error reading log: %w", err)
	}
	
	return nil
}

// AddFilter adds a filter
func (la *LogAnalyzer) AddFilter(filter Filter) {
	la.filters = append(la.filters, filter)
}

// ClearFilters removes all filters
func (la *LogAnalyzer) ClearFilters() {
	la.filters = []Filter{}
}

// GetEntries returns filtered entries
func (la *LogAnalyzer) GetEntries() []LogEntry {
	if len(la.filters) == 0 {
		return la.entries
	}
	
	filtered := []LogEntry{}
	for _, entry := range la.entries {
		if la.matchesAllFilters(entry) {
			filtered = append(filtered, entry)
		}
	}
	
	return filtered
}

// GetStats returns log statistics
func (la *LogAnalyzer) GetStats() *LogStats {
	stats := &LogStats{
		TotalEntries:   len(la.entries),
		LevelCounts:    make(map[string]int),
		LoggerCounts:   make(map[string]int),
		MessageCounts:  make(map[string]int),
		ErrorTypes:     make(map[string]int),
		TimeRange:      TimeRange{},
	}
	
	if len(la.entries) == 0 {
		return stats
	}
	
	// Initialize time range
	stats.TimeRange.Start = la.entries[0].Timestamp
	stats.TimeRange.End = la.entries[0].Timestamp
	
	for _, entry := range la.entries {
		// Count by level
		stats.LevelCounts[entry.Level]++
		
		// Count by logger
		stats.LoggerCounts[entry.Logger]++
		
		// Count messages (simplified - in practice would normalize)
		msgKey := normalizeMessage(entry.Message)
		stats.MessageCounts[msgKey]++
		
		// Track errors
		if entry.Level == "error" {
			if errType, ok := entry.Fields["error_kind"].(string); ok {
				stats.ErrorTypes[errType]++
			}
		}
		
		// Update time range
		if entry.Timestamp.Before(stats.TimeRange.Start) {
			stats.TimeRange.Start = entry.Timestamp
		}
		if entry.Timestamp.After(stats.TimeRange.End) {
			stats.TimeRange.End = entry.Timestamp
		}
	}
	
	return stats
}

// GetTimeline returns entries grouped by time
func (la *LogAnalyzer) GetTimeline(interval time.Duration) []TimelineEntry {
	entries := la.GetEntries()
	if len(entries) == 0 {
		return []TimelineEntry{}
	}
	
	// Sort by timestamp
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp.Before(entries[j].Timestamp)
	})
	
	timeline := []TimelineEntry{}
	
	start := entries[0].Timestamp.Truncate(interval)
	current := TimelineEntry{
		Time:   start,
		Counts: make(map[string]int),
	}
	
	for _, entry := range entries {
		bucket := entry.Timestamp.Truncate(interval)
		
		if !bucket.Equal(current.Time) {
			timeline = append(timeline, current)
			current = TimelineEntry{
				Time:   bucket,
				Counts: make(map[string]int),
			}
		}
		
		current.Counts[entry.Level]++
		current.Total++
	}
	
	// Add last bucket
	if current.Total > 0 {
		timeline = append(timeline, current)
	}
	
	return timeline
}

// GetErrorSummary returns error analysis
func (la *LogAnalyzer) GetErrorSummary() *ErrorSummary {
	errors := []LogEntry{}
	
	for _, entry := range la.GetEntries() {
		if entry.Level == "error" || entry.Level == "fatal" {
			errors = append(errors, entry)
		}
	}
	
	summary := &ErrorSummary{
		TotalErrors:    len(errors),
		ErrorsByLogger: make(map[string]int),
		ErrorsByType:   make(map[string]int),
		CommonPatterns: []ErrorPattern{},
	}
	
	// Group by logger
	for _, err := range errors {
		summary.ErrorsByLogger[err.Logger]++
		
		// Extract error type
		if errType, ok := err.Fields["error_kind"].(string); ok {
			summary.ErrorsByType[errType]++
		}
	}
	
	// Find common patterns
	patterns := findErrorPatterns(errors)
	summary.CommonPatterns = patterns
	
	return summary
}

// GetPerformanceInsights analyzes performance-related logs
func (la *LogAnalyzer) GetPerformanceInsights() *PerformanceInsights {
	insights := &PerformanceInsights{
		SlowOperations:    []SlowOperation{},
		ResourceUsage:     ResourceUsage{},
		BottleneckSummary: []string{},
	}
	
	for _, entry := range la.GetEntries() {
		// Check for operation duration
		if duration, ok := entry.Fields["duration"].(float64); ok {
			if duration > 1000 { // Over 1 second
				insights.SlowOperations = append(insights.SlowOperations, SlowOperation{
					Operation: entry.Fields["operation"].(string),
					Duration:  time.Duration(duration) * time.Millisecond,
					Timestamp: entry.Timestamp,
				})
			}
		}
		
		// Check for resource metrics
		if entry.Logger == "metrics" {
			if cpu, ok := entry.Fields["cpu_percent"].(float64); ok {
				insights.ResourceUsage.MaxCPU = max(insights.ResourceUsage.MaxCPU, cpu)
			}
			if mem, ok := entry.Fields["memory_mb"].(float64); ok {
				insights.ResourceUsage.MaxMemoryMB = max(insights.ResourceUsage.MaxMemoryMB, uint64(mem))
			}
		}
	}
	
	// Analyze bottlenecks
	if len(insights.SlowOperations) > 10 {
		insights.BottleneckSummary = append(insights.BottleneckSummary, 
			fmt.Sprintf("Found %d slow operations", len(insights.SlowOperations)))
	}
	
	if insights.ResourceUsage.MaxCPU > 80 {
		insights.BottleneckSummary = append(insights.BottleneckSummary,
			fmt.Sprintf("High CPU usage detected: %.1f%%", insights.ResourceUsage.MaxCPU))
	}
	
	return insights
}

// matchesAllFilters checks if entry matches all filters
func (la *LogAnalyzer) matchesAllFilters(entry LogEntry) bool {
	for _, filter := range la.filters {
		if !filter(entry) {
			return false
		}
	}
	return true
}

// Common filters

// LevelFilter filters by log level
func LevelFilter(levels ...string) Filter {
	levelSet := make(map[string]bool)
	for _, level := range levels {
		levelSet[level] = true
	}
	
	return func(entry LogEntry) bool {
		return levelSet[entry.Level]
	}
}

// TimeRangeFilter filters by time range
func TimeRangeFilter(start, end time.Time) Filter {
	return func(entry LogEntry) bool {
		return !entry.Timestamp.Before(start) && !entry.Timestamp.After(end)
	}
}

// LoggerFilter filters by logger name
func LoggerFilter(loggers ...string) Filter {
	loggerSet := make(map[string]bool)
	for _, logger := range loggers {
		loggerSet[logger] = true
	}
	
	return func(entry LogEntry) bool {
		return loggerSet[entry.Logger]
	}
}

// MessageFilter filters by message content
func MessageFilter(substring string) Filter {
	lower := strings.ToLower(substring)
	return func(entry LogEntry) bool {
		return strings.Contains(strings.ToLower(entry.Message), lower)
	}
}

// FieldFilter filters by field value
func FieldFilter(field string, value interface{}) Filter {
	return func(entry LogEntry) bool {
		if v, ok := entry.Fields[field]; ok {
			return v == value
		}
		return false
	}
}

// Helper functions

func parseLogLine(line string) (LogEntry, error) {
	entry := LogEntry{
		Raw:    line,
		Fields: make(map[string]interface{}),
	}
	
	// Parse JSON log
	var rawEntry map[string]interface{}
	if err := json.Unmarshal([]byte(line), &rawEntry); err != nil {
		return entry, err
	}
	
	// Extract standard fields
	if timestamp, ok := rawEntry["timestamp"].(string); ok {
		if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
			entry.Timestamp = t
		}
	}
	
	if level, ok := rawEntry["level"].(string); ok {
		entry.Level = level
	}
	
	if logger, ok := rawEntry["logger"].(string); ok {
		entry.Logger = logger
	}
	
	if msg, ok := rawEntry["msg"].(string); ok {
		entry.Message = msg
	}
	
	if caller, ok := rawEntry["caller"].(string); ok {
		entry.Caller = caller
	}
	
	if stacktrace, ok := rawEntry["stacktrace"].(string); ok {
		entry.StackTrace = stacktrace
	}
	
	// Store remaining fields
	for k, v := range rawEntry {
		if k != "timestamp" && k != "level" && k != "logger" && k != "msg" && k != "caller" && k != "stacktrace" {
			entry.Fields[k] = v
		}
	}
	
	return entry, nil
}

func normalizeMessage(msg string) string {
	// Simple normalization - in practice would be more sophisticated
	if len(msg) > 50 {
		return msg[:50] + "..."
	}
	return msg
}

func findErrorPatterns(errors []LogEntry) []ErrorPattern {
	patterns := []ErrorPattern{}
	
	// Group by message similarity (simplified)
	messageGroups := make(map[string][]LogEntry)
	
	for _, err := range errors {
		key := normalizeMessage(err.Message)
		messageGroups[key] = append(messageGroups[key], err)
	}
	
	// Create patterns from groups
	for msg, entries := range messageGroups {
		if len(entries) >= 3 { // At least 3 occurrences
			patterns = append(patterns, ErrorPattern{
				Pattern:     msg,
				Count:       len(entries),
				FirstSeen:   entries[0].Timestamp,
				LastSeen:    entries[len(entries)-1].Timestamp,
				ExampleLogs: entries[:min(3, len(entries))],
			})
		}
	}
	
	// Sort by count
	sort.Slice(patterns, func(i, j int) bool {
		return patterns[i].Count > patterns[j].Count
	})
	
	return patterns
}

// Analysis result types

type LogStats struct {
	TotalEntries  int
	LevelCounts   map[string]int
	LoggerCounts  map[string]int
	MessageCounts map[string]int
	ErrorTypes    map[string]int
	TimeRange     TimeRange
}

type TimeRange struct {
	Start time.Time
	End   time.Time
}

type TimelineEntry struct {
	Time   time.Time
	Total  int
	Counts map[string]int
}

type ErrorSummary struct {
	TotalErrors    int
	ErrorsByLogger map[string]int
	ErrorsByType   map[string]int
	CommonPatterns []ErrorPattern
}

type ErrorPattern struct {
	Pattern     string
	Count       int
	FirstSeen   time.Time
	LastSeen    time.Time
	ExampleLogs []LogEntry
}

type PerformanceInsights struct {
	SlowOperations    []SlowOperation
	ResourceUsage     ResourceUsage
	BottleneckSummary []string
}

type SlowOperation struct {
	Operation string
	Duration  time.Duration
	Timestamp time.Time
}

type ResourceUsage struct {
	MaxCPU      float64
	MaxMemoryMB uint64
}

// Utility functions
func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}