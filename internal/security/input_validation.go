package security

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"go.uber.org/zap"
)

// InputValidator provides comprehensive input validation
type InputValidator struct {
	logger *zap.Logger
	
	// Validation rules
	rules      map[string]ValidationRule
	
	// SQL injection patterns
	sqlPatterns []*regexp.Regexp
	
	// Path traversal patterns
	pathPatterns []*regexp.Regexp
	
	// Command injection patterns
	cmdPatterns []*regexp.Regexp
	
	// Configuration
	config     ValidationConfig
}

// ValidationConfig defines validation configuration
type ValidationConfig struct {
	// Length limits
	MaxStringLength   int `json:"max_string_length"`
	MaxArrayLength    int `json:"max_array_length"`
	MaxJSONDepth      int `json:"max_json_depth"`
	MaxFileSize       int64 `json:"max_file_size"`
	
	// Pattern validation
	EnablePatternCheck bool `json:"enable_pattern_check"`
	CustomPatterns    map[string]string `json:"custom_patterns"`
	
	// File validation
	AllowedFileTypes  []string `json:"allowed_file_types"`
	BlockedFileTypes  []string `json:"blocked_file_types"`
	
	// Network validation
	AllowPrivateIPs   bool `json:"allow_private_ips"`
	AllowedPorts      []int `json:"allowed_ports"`
	
	// Encoding
	RequireUTF8       bool `json:"require_utf8"`
}

// ValidationRule defines a validation rule
type ValidationRule struct {
	Type        string                 `json:"type"`
	Required    bool                   `json:"required"`
	MinLength   int                    `json:"min_length"`
	MaxLength   int                    `json:"max_length"`
	Pattern     string                 `json:"pattern"`
	Min         float64                `json:"min"`
	Max         float64                `json:"max"`
	Enum        []string               `json:"enum"`
	CustomFunc  func(interface{}) error `json:"-"`
}

// ValidationResult contains validation results
type ValidationResult struct {
	Valid    bool
	Errors   []ValidationError
	Warnings []string
}

// ValidationError represents a validation error
type ValidationError struct {
	Field   string
	Message string
	Code    string
}

// NewInputValidator creates a new input validator
func NewInputValidator(logger *zap.Logger, config ValidationConfig) *InputValidator {
	// Set defaults
	if config.MaxStringLength == 0 {
		config.MaxStringLength = 10000
	}
	if config.MaxArrayLength == 0 {
		config.MaxArrayLength = 1000
	}
	if config.MaxJSONDepth == 0 {
		config.MaxJSONDepth = 10
	}
	if config.MaxFileSize == 0 {
		config.MaxFileSize = 10 * 1024 * 1024 // 10MB
	}
	
	iv := &InputValidator{
		logger: logger,
		config: config,
		rules:  make(map[string]ValidationRule),
	}
	
	// Initialize patterns
	iv.initializeSQLPatterns()
	iv.initializePathPatterns()
	iv.initializeCommandPatterns()
	
	// Register default rules
	iv.registerDefaultRules()
	
	return iv
}

// initializeSQLPatterns sets up SQL injection patterns
func (iv *InputValidator) initializeSQLPatterns() {
	patterns := []string{
		`(?i)(union.*select)`,
		`(?i)(select.*from)`,
		`(?i)(insert.*into)`,
		`(?i)(delete.*from)`,
		`(?i)(update.*set)`,
		`(?i)(drop.*table)`,
		`(?i)(create.*table)`,
		`(?i)(alter.*table)`,
		`(?i)(exec(ute)?.*\()`,
		`(?i)(script.*>)`,
		`(?i)(javascript:)`,
		`(?i)(vbscript:)`,
		`(?i)(onload.*=)`,
		`(?i)(onerror.*=)`,
		`(?i)(onclick.*=)`,
		`--`,
		`/\*.*\*/`,
		`\x00`,
		`\x1a`,
	}
	
	iv.sqlPatterns = make([]*regexp.Regexp, len(patterns))
	for i, pattern := range patterns {
		iv.sqlPatterns[i] = regexp.MustCompile(pattern)
	}
}

// initializePathPatterns sets up path traversal patterns
func (iv *InputValidator) initializePathPatterns() {
	patterns := []string{
		`\.\.\/`,
		`\.\.\\`,
		`%2e%2e%2f`,
		`%2e%2e%5c`,
		`\.\./`,
		`\.\.\\`,
		`%252e%252e%252f`,
		`%c0%af`,
		`%c1%9c`,
	}
	
	iv.pathPatterns = make([]*regexp.Regexp, len(patterns))
	for i, pattern := range patterns {
		iv.pathPatterns[i] = regexp.MustCompile(pattern)
	}
}

// initializeCommandPatterns sets up command injection patterns
func (iv *InputValidator) initializeCommandPatterns() {
	patterns := []string{
		`;`,
		`\|`,
		`&`,
		`\$\(`,
		"\\`",
		`>`,
		`<`,
		`\${`,
		`%0a`,
		`%0d`,
		`\n`,
		`\r`,
	}
	
	iv.cmdPatterns = make([]*regexp.Regexp, len(patterns))
	for i, pattern := range patterns {
		iv.cmdPatterns[i] = regexp.MustCompile(pattern)
	}
}

// registerDefaultRules registers default validation rules
func (iv *InputValidator) registerDefaultRules() {
	// Email validation
	iv.RegisterRule("email", ValidationRule{
		Type:      "string",
		Pattern:   `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`,
		MaxLength: 254,
	})
	
	// Username validation
	iv.RegisterRule("username", ValidationRule{
		Type:      "string",
		Pattern:   `^[a-zA-Z0-9_-]{3,32}$`,
		MinLength: 3,
		MaxLength: 32,
	})
	
	// Password validation
	iv.RegisterRule("password", ValidationRule{
		Type:      "string",
		MinLength: 8,
		MaxLength: 128,
		CustomFunc: iv.validatePassword,
	})
	
	// URL validation
	iv.RegisterRule("url", ValidationRule{
		Type:      "string",
		MaxLength: 2048,
		CustomFunc: iv.validateURL,
	})
	
	// IP address validation
	iv.RegisterRule("ip", ValidationRule{
		Type:      "string",
		CustomFunc: iv.validateIP,
	})
	
	// Port validation
	iv.RegisterRule("port", ValidationRule{
		Type: "number",
		Min:  1,
		Max:  65535,
	})
	
	// Ethereum address validation
	iv.RegisterRule("eth_address", ValidationRule{
		Type:    "string",
		Pattern: `^0x[a-fA-F0-9]{40}$`,
	})
	
	// Bitcoin address validation
	iv.RegisterRule("btc_address", ValidationRule{
		Type:    "string",
		Pattern: `^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$`,
	})
}

// RegisterRule registers a validation rule
func (iv *InputValidator) RegisterRule(name string, rule ValidationRule) {
	iv.rules[name] = rule
}

// Validate validates input against a rule
func (iv *InputValidator) Validate(input interface{}, ruleName string) ValidationResult {
	result := ValidationResult{Valid: true}
	
	rule, exists := iv.rules[ruleName]
	if !exists {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:   ruleName,
			Message: fmt.Sprintf("validation rule '%s' not found", ruleName),
			Code:    "RULE_NOT_FOUND",
		})
		return result
	}
	
	// Type validation
	if !iv.validateType(input, rule.Type) {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:   ruleName,
			Message: fmt.Sprintf("expected type %s", rule.Type),
			Code:    "INVALID_TYPE",
		})
		return result
	}
	
	// String validations
	if rule.Type == "string" {
		str, _ := input.(string)
		
		// Length validation
		if len(str) < rule.MinLength {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: fmt.Sprintf("minimum length is %d", rule.MinLength),
				Code:    "MIN_LENGTH",
			})
		}
		
		if rule.MaxLength > 0 && len(str) > rule.MaxLength {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: fmt.Sprintf("maximum length is %d", rule.MaxLength),
				Code:    "MAX_LENGTH",
			})
		}
		
		// Pattern validation
		if rule.Pattern != "" {
			if matched, _ := regexp.MatchString(rule.Pattern, str); !matched {
				result.Valid = false
				result.Errors = append(result.Errors, ValidationError{
					Field:   ruleName,
					Message: "invalid format",
					Code:    "INVALID_FORMAT",
				})
			}
		}
		
		// Security checks
		if iv.config.EnablePatternCheck {
			if iv.containsSQLInjection(str) {
				result.Valid = false
				result.Errors = append(result.Errors, ValidationError{
					Field:   ruleName,
					Message: "potential SQL injection detected",
					Code:    "SQL_INJECTION",
				})
			}
			
			if iv.containsPathTraversal(str) {
				result.Valid = false
				result.Errors = append(result.Errors, ValidationError{
					Field:   ruleName,
					Message: "potential path traversal detected",
					Code:    "PATH_TRAVERSAL",
				})
			}
		}
		
		// UTF-8 validation
		if iv.config.RequireUTF8 && !utf8.ValidString(str) {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: "invalid UTF-8 encoding",
				Code:    "INVALID_ENCODING",
			})
		}
	}
	
	// Number validations
	if rule.Type == "number" {
		var num float64
		switch v := input.(type) {
		case int:
			num = float64(v)
		case int64:
			num = float64(v)
		case float64:
			num = v
		case string:
			var err error
			num, err = strconv.ParseFloat(v, 64)
			if err != nil {
				result.Valid = false
				result.Errors = append(result.Errors, ValidationError{
					Field:   ruleName,
					Message: "invalid number format",
					Code:    "INVALID_NUMBER",
				})
				return result
			}
		}
		
		if num < rule.Min {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: fmt.Sprintf("minimum value is %f", rule.Min),
				Code:    "MIN_VALUE",
			})
		}
		
		if rule.Max > 0 && num > rule.Max {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: fmt.Sprintf("maximum value is %f", rule.Max),
				Code:    "MAX_VALUE",
			})
		}
	}
	
	// Enum validation
	if len(rule.Enum) > 0 {
		str, _ := input.(string)
		found := false
		for _, allowed := range rule.Enum {
			if str == allowed {
				found = true
				break
			}
		}
		if !found {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: fmt.Sprintf("must be one of: %s", strings.Join(rule.Enum, ", ")),
				Code:    "INVALID_ENUM",
			})
		}
	}
	
	// Custom validation
	if rule.CustomFunc != nil {
		if err := rule.CustomFunc(input); err != nil {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   ruleName,
				Message: err.Error(),
				Code:    "CUSTOM_VALIDATION",
			})
		}
	}
	
	return result
}

// ValidateStruct validates a struct
func (iv *InputValidator) ValidateStruct(data interface{}, rules map[string]string) ValidationResult {
	result := ValidationResult{Valid: true}
	
	// Convert to map for easier processing
	jsonData, err := json.Marshal(data)
	if err != nil {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Message: "invalid data structure",
			Code:    "INVALID_STRUCTURE",
		})
		return result
	}
	
	var dataMap map[string]interface{}
	if err := json.Unmarshal(jsonData, &dataMap); err != nil {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Message: "invalid data structure",
			Code:    "INVALID_STRUCTURE",
		})
		return result
	}
	
	// Validate each field
	for field, ruleName := range rules {
		value, exists := dataMap[field]
		
		rule, ruleExists := iv.rules[ruleName]
		if !ruleExists {
			result.Warnings = append(result.Warnings, fmt.Sprintf("rule '%s' not found for field '%s'", ruleName, field))
			continue
		}
		
		if !exists && rule.Required {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   field,
				Message: "field is required",
				Code:    "REQUIRED_FIELD",
			})
			continue
		}
		
		if exists {
			fieldResult := iv.Validate(value, ruleName)
			if !fieldResult.Valid {
				result.Valid = false
				for _, err := range fieldResult.Errors {
					err.Field = field
					result.Errors = append(result.Errors, err)
				}
			}
		}
	}
	
	return result
}

// SanitizeFilename sanitizes a filename
func (iv *InputValidator) SanitizeFilename(filename string) string {
	// Remove path components
	filename = filepath.Base(filename)
	
	// Remove dangerous characters
	dangerousChars := []string{"..", "/", "\\", ":", "*", "?", "\"", "<", ">", "|", "\x00"}
	for _, char := range dangerousChars {
		filename = strings.ReplaceAll(filename, char, "_")
	}
	
	// Limit length
	if len(filename) > 255 {
		ext := filepath.Ext(filename)
		base := filename[:255-len(ext)]
		filename = base + ext
	}
	
	return filename
}

// ValidateFileUpload validates file upload
func (iv *InputValidator) ValidateFileUpload(filename string, size int64, contentType string) ValidationResult {
	result := ValidationResult{Valid: true}
	
	// Check file size
	if size > iv.config.MaxFileSize {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:   "file",
			Message: fmt.Sprintf("file size exceeds maximum of %d bytes", iv.config.MaxFileSize),
			Code:    "FILE_TOO_LARGE",
		})
	}
	
	// Check file extension
	ext := strings.ToLower(filepath.Ext(filename))
	
	// Check blocked types
	for _, blocked := range iv.config.BlockedFileTypes {
		if ext == blocked {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   "file",
				Message: fmt.Sprintf("file type %s is not allowed", ext),
				Code:    "BLOCKED_FILE_TYPE",
			})
			return result
		}
	}
	
	// Check allowed types if specified
	if len(iv.config.AllowedFileTypes) > 0 {
		allowed := false
		for _, allowedType := range iv.config.AllowedFileTypes {
			if ext == allowedType {
				allowed = true
				break
			}
		}
		if !allowed {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:   "file",
				Message: fmt.Sprintf("file type %s is not allowed", ext),
				Code:    "INVALID_FILE_TYPE",
			})
		}
	}
	
	return result
}

// Helper validation functions

func (iv *InputValidator) validateType(input interface{}, expectedType string) bool {
	switch expectedType {
	case "string":
		_, ok := input.(string)
		return ok
	case "number":
		switch input.(type) {
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
			return true
		case string:
			_, err := strconv.ParseFloat(input.(string), 64)
			return err == nil
		}
		return false
	case "bool":
		_, ok := input.(bool)
		return ok
	case "array":
		switch input.(type) {
		case []interface{}, []string, []int, []float64:
			return true
		}
		return false
	case "object":
		_, ok := input.(map[string]interface{})
		return ok
	}
	return false
}

func (iv *InputValidator) containsSQLInjection(input string) bool {
	input = strings.ToLower(input)
	for _, pattern := range iv.sqlPatterns {
		if pattern.MatchString(input) {
			return true
		}
	}
	return false
}

func (iv *InputValidator) containsPathTraversal(input string) bool {
	for _, pattern := range iv.pathPatterns {
		if pattern.MatchString(input) {
			return true
		}
	}
	return false
}

func (iv *InputValidator) containsCommandInjection(input string) bool {
	for _, pattern := range iv.cmdPatterns {
		if pattern.MatchString(input) {
			return true
		}
	}
	return false
}

func (iv *InputValidator) validatePassword(input interface{}) error {
	password, ok := input.(string)
	if !ok {
		return fmt.Errorf("password must be a string")
	}
	
	// Check complexity
	var hasUpper, hasLower, hasDigit, hasSpecial bool
	
	for _, char := range password {
		switch {
		case char >= 'A' && char <= 'Z':
			hasUpper = true
		case char >= 'a' && char <= 'z':
			hasLower = true
		case char >= '0' && char <= '9':
			hasDigit = true
		case strings.ContainsRune("!@#$%^&*()_+-=[]{}|;:,.<>?", char):
			hasSpecial = true
		}
	}
	
	if !hasUpper || !hasLower || !hasDigit || !hasSpecial {
		return fmt.Errorf("password must contain uppercase, lowercase, digit, and special character")
	}
	
	return nil
}

func (iv *InputValidator) validateURL(input interface{}) error {
	urlStr, ok := input.(string)
	if !ok {
		return fmt.Errorf("URL must be a string")
	}
	
	u, err := url.Parse(urlStr)
	if err != nil {
		return fmt.Errorf("invalid URL format")
	}
	
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("URL must use http or https scheme")
	}
	
	if u.Host == "" {
		return fmt.Errorf("URL must have a host")
	}
	
	return nil
}

func (iv *InputValidator) validateIP(input interface{}) error {
	ipStr, ok := input.(string)
	if !ok {
		return fmt.Errorf("IP address must be a string")
	}
	
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return fmt.Errorf("invalid IP address format")
	}
	
	if !iv.config.AllowPrivateIPs {
		if ip.IsPrivate() || ip.IsLoopback() {
			return fmt.Errorf("private IP addresses not allowed")
		}
	}
	
	return nil
}