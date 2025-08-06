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

// LogAnalyzer provides capabilities to parse and analyze log files.
// It is designed to work with the JSON output from the logger.	ype LogAnalyzer struct {
	entries []LogEntry
	filters []Filter
}

// LogEntry represents a single, parsed log entry.
// The JSON tags correspond to the output format defined in the logger's encoder configuration.	ype LogEntry struct {
	Timestamp   time.Time              `json:"ts"`
	Level       string                 `json:"level"`
	Logger      string                 `json:"logger"`
	Message     string                 `json:"msg"`
	Caller      string                 `json:"caller,omitempty"`
	StackTrace  string                 `json:"stack,omitempty"`
	// Fields contains all other dynamic fields from the log entry.
	Fields      map[string]interface{} `json:"-"`
	// Raw stores the original, unparsed log line.
	Raw         string                 `json:"-"`
}

// Filter is a function that returns true if a log entry should be included in an analysis.	ype Filter func(entry LogEntry) bool

// NewLogAnalyzer creates a new, empty log analyzer.
func NewLogAnalyzer() *LogAnalyzer {
	return &LogAnalyzer{
		entries: []LogEntry{},
		filters: []Filter{},
	}
}

// LoadFile opens a log file and loads its contents into the analyzer.
func (la *LogAnalyzer) LoadFile(filename string) error {
	file, err := os.Open(filename)
	if err != nil {
		return fmt.Errorf("failed to open log file: %w", err)
	}
	defer file.Close()
	return la.LoadReader(file)
}

// LoadReader consumes log entries from an io.Reader.
func (la *LogAnalyzer) LoadReader(reader io.Reader) error {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		entry, err := parseLogLine(line)
		if err != nil {
			// If parsing fails, store the line as a raw entry.
			entry = LogEntry{
				Timestamp: time.Now(), // Assign a timestamp for sorting purposes.
				Level:     "unknown",
				Message:   line,
				Raw:       line,
			}
		}
		la.entries = append(la.entries, entry)
	}
	return scanner.Err()
}

// AddFilter adds a filter to the analyzer's filter chain.
func (la *LogAnalyzer) AddFilter(filter Filter) {
	la.filters = append(la.filters, filter)
}

// ClearFilters removes all active filters.
func (la *LogAnalyzer) ClearFilters() {
	la.filters = []Filter{}
}

// GetEntries returns the log entries that match all active filters.
func (la *LogAnalyzer) GetEntries() []LogEntry {
	if len(la.filters) == 0 {
		return la.entries
	}

	filtered := make([]LogEntry, 0)
	for _, entry := range la.entries {
		if la.matchesAllFilters(entry) {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}

// matchesAllFilters checks if a log entry satisfies all registered filters.
func (la *LogAnalyzer) matchesAllFilters(entry LogEntry) bool {
	for _, filter := range la.filters {
		if !filter(entry) {
			return false
		}
	}
	return true
}

// parseLogLine converts a JSON log line into a LogEntry struct.
func parseLogLine(line string) (LogEntry, error) {
	var rawEntry map[string]interface{}
	if err := json.Unmarshal([]byte(line), &rawEntry); err != nil {
		return LogEntry{}, err
	}

	entry := LogEntry{
		Raw:    line,
		Fields: make(map[string]interface{}),
	}

	// Extract well-known fields from the raw map.
	if ts, ok := rawEntry["ts"]; ok {
		if t, err := time.Parse(time.RFC3339Nano, fmt.Sprintf("%v", ts)); err == nil {
			entry.Timestamp = t
		} else if f, ok := ts.(float64); ok {
			// Handle Unix timestamp format.
			sec, dec :=- math.Modf(f)
			entry.Timestamp = time.Unix(int64(sec), int64(dec*(1e9)))
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
	if stack, ok := rawEntry["stack"].(string); ok {
		entry.StackTrace = stack
	}

	// Store all other fields in the Fields map.
	for k, v := range rawEntry {
		switch k {
		case "ts", "level", "logger", "msg", "caller", "stack":
			// Skip already processed fields.
		default:
			entry.Fields[k] = v
		}
	}

	return entry, nil
}

// --- Analysis & Filtering Functions ---

// LevelFilter creates a filter for specific log levels.
func LevelFilter(levels ...string) Filter {
	levelSet := make(map[string]struct{}, len(levels))
	for _, level := range levels {
		levelSet[level] = struct{}{}
	}
	return func(entry LogEntry) bool {
		_, ok := levelSet[entry.Level]
		return ok
	}
}

// TimeRangeFilter creates a filter for a specific time window.
func TimeRangeFilter(start, end time.Time) Filter {
	return func(entry LogEntry) bool {
		return !entry.Timestamp.Before(start) && !entry.Timestamp.After(end)
	}
}

// MessageFilter creates a filter that searches for a substring in the log message.
func MessageFilter(substring string) Filter {
	lowerSubstr := strings.ToLower(substring)
	return func(entry LogEntry) bool {
		return strings.Contains(strings.ToLower(entry.Message), lowerSubstr)
	}
}

// FieldFilter creates a filter for a specific key-value pair in the dynamic fields.
func FieldFilter(field string, value interface{}) Filter {
	return func(entry LogEntry) bool {
		if v, ok := entry.Fields[field]; ok {
			return v == value
		}
		return false
	}
}
