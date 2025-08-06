package common

import (
	"strings"
	"testing"
	"unicode"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Common validation framework for Otedama mining pool

// ValidationError represents a validation error
type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
	Code    string `json:"code"`
}

func (e ValidationError) Error() string {
	return e.Message
}

// Validator provides common validation functionality
type Validator struct {
	errors []ValidationError
}

// NewValidator creates a new validator instance
func NewValidator() *Validator {
	return &Validator{
		errors: make([]ValidationError, 0),
	}
}

// AddError adds a validation error
func (v *Validator) AddError(field, message, code string) {
	v.errors = append(v.errors, ValidationError{
		Field:   field,
		Message: message,
		Code:    code,
	})
}

// HasErrors returns true if there are validation errors
func (v *Validator) HasErrors() bool {
	return len(v.errors) > 0
}

// GetErrors returns all validation errors
func (v *Validator) GetErrors() []ValidationError {
	return v.errors
}

// Clear clears all validation errors
func (v *Validator) Clear() {
	v.errors = v.errors[:0]
}

// Validation functions

// ValidateRequired checks if a field is not empty
func (v *Validator) ValidateRequired(field, value, displayName string) bool {
	if strings.TrimSpace(value) == "" {
		v.AddError(field, displayName+" is required", "required")
		return false
	}
	return true
}

// ValidateMinLength checks minimum string length
func (v *Validator) ValidateMinLength(field, value, displayName string, minLen int) bool {
	if len(value) < minLen {
		v.AddError(field, displayName+" must be at least "+string(rune(minLen))+" characters", "min_length")
		return false
	}
	return true
}

// ValidateMaxLength checks maximum string length
func (v *Validator) ValidateMaxLength(field, value, displayName string, maxLen int) bool {
	if len(value) > maxLen {
		v.AddError(field, displayName+" must be at most "+string(rune(maxLen))+" characters", "max_length")
		return false
	}
	return true
}

// ValidateRange checks if an integer is within range
func (v *Validator) ValidateRange(field, displayName string, value, min, max int) bool {
	if value < min || value > max {
		v.AddError(field, displayName+" must be between "+string(rune(min))+" and "+string(rune(max)), "range")
		return false
	}
	return true
}

// ValidateFloatRange checks if a float is within range
func (v *Validator) ValidateFloatRange(field, displayName string, value, min, max float64) bool {
	if value < min || value > max {
		v.AddError(field, displayName+" must be between "+string(rune(int(min)))+" and "+string(rune(int(max))), "float_range")
		return false
	}
	return true
}

// ValidateAlphanumeric checks if string contains only alphanumeric characters
func (v *Validator) ValidateAlphanumeric(field, value, displayName string) bool {
	for _, r := range value {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' {
			v.AddError(field, displayName+" can only contain letters, numbers, underscores, and hyphens", "alphanumeric")
			return false
		}
	}
	return true
}

// ValidateHexString checks if string is valid hexadecimal
func (v *Validator) ValidateHexString(field, value, displayName string) bool {
	if value == "" {
		return true // Empty is valid for optional hex fields
	}
	
	// Remove 0x prefix if present
	if strings.HasPrefix(value, "0x") {
		value = value[2:]
	}
	
	for _, r := range value {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			v.AddError(field, displayName+" must be a valid hexadecimal string", "hex_string")
			return false
		}
	}
	return true
}

// ValidateAddress checks if string is a valid wallet/mining address
func (v *Validator) ValidateAddress(field, value, displayName string) bool {
	if value == "" {
		v.AddError(field, displayName+" is required", "required")
		return false
	}
	
	// Basic address validation (simplified)
	if len(value) < 26 || len(value) > 62 {
		v.AddError(field, displayName+" must be between 26 and 62 characters", "invalid_address")
		return false
	}
	
	// Check for valid characters (alphanumeric)
	for _, r := range value {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			v.AddError(field, displayName+" contains invalid characters", "invalid_address")
			return false
		}
	}
	
	return true
}

// ValidateWorkerName checks if worker name is valid
func (v *Validator) ValidateWorkerName(field, value, displayName string) bool {
	if !v.ValidateRequired(field, value, displayName) {
		return false
	}
	
	if !v.ValidateMinLength(field, value, displayName, 3) {
		return false
	}
	
	if !v.ValidateMaxLength(field, value, displayName, 64) {
		return false
	}
	
	// Worker names can contain letters, numbers, underscores, hyphens, and dots
	for _, r := range value {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' && r != '.' {
			v.AddError(field, displayName+" can only contain letters, numbers, underscores, hyphens, and dots", "invalid_worker_name")
			return false
		}
	}
	
	return true
}

// ValidateAlgorithm checks if algorithm name is valid
func (v *Validator) ValidateAlgorithm(field, value, displayName string) bool {
	validAlgorithms := map[string]bool{
		"sha256":  true,
		"sha256d": true,
		"scrypt":  true,
		"ethash":  true,
		"randomx": true,
		"kawpow":  true,
		"x11":     true,
		"lyra2z":  true,
	}
	
	if !validAlgorithms[strings.ToLower(value)] {
		v.AddError(field, displayName+" is not a supported algorithm", "invalid_algorithm")
		return false
	}
	
	return true
}

// ValidateDifficulty checks if difficulty value is valid
func (v *Validator) ValidateDifficulty(field, displayName string, value float64) bool {
	if value <= 0 {
		v.AddError(field, displayName+" must be greater than 0", "invalid_difficulty")
		return false
	}
	
	if value > 1e12 { // Very high difficulty limit
		v.AddError(field, displayName+" is too high", "difficulty_too_high")
		return false
	}
	
	return true
}

// ValidateHashRate checks if hash rate value is valid
func (v *Validator) ValidateHashRate(field, displayName string, value uint64) bool {
	if value == 0 {
		v.AddError(field, displayName+" must be greater than 0", "invalid_hashrate")
		return false
	}
	
	// Very high hash rate limit (1 EH/s)
	if value > 1e18 {
		v.AddError(field, displayName+" is unrealistically high", "hashrate_too_high")
		return false
	}
	
	return true
}

// ValidatePoolFee checks if pool fee percentage is valid
func (v *Validator) ValidatePoolFee(field, displayName string, value float64) bool {
	if value < 0 {
		v.AddError(field, displayName+" cannot be negative", "negative_fee")
		return false
	}
	
	if value > 10.0 { // 10% maximum
		v.AddError(field, displayName+" cannot exceed 10%", "fee_too_high")
		return false
	}
	
	return true
}

// ValidatePayoutAmount checks if payout amount is valid
func (v *Validator) ValidatePayoutAmount(field, displayName string, value float64) bool {
	if value <= 0 {
		v.AddError(field, displayName+" must be greater than 0", "invalid_amount")
		return false
	}
	
	if value > 1000000 { // 1M coin limit
		v.AddError(field, displayName+" is too large", "amount_too_large")
		return false
	}
	
	return true
}

// ValidateEmail checks if email format is valid (basic validation)
func (v *Validator) ValidateEmail(field, value, displayName string) bool {
	if value == "" {
		return true // Email is usually optional
	}
	
	if !strings.Contains(value, "@") {
		v.AddError(field, displayName+" must contain @", "invalid_email")
		return false
	}
	
	parts := strings.Split(value, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		v.AddError(field, displayName+" format is invalid", "invalid_email")
		return false
	}
	
	if !strings.Contains(parts[1], ".") {
		v.AddError(field, displayName+" domain is invalid", "invalid_email")
		return false
	}
	
	return true
}

// ValidateURL checks if URL format is valid (basic validation)
func (v *Validator) ValidateURL(field, value, displayName string) bool {
	if value == "" {
		v.AddError(field, displayName+" is required", "required")
		return false
	}
	
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		v.AddError(field, displayName+" must start with http:// or https://", "invalid_url")
		return false
	}
	
	if len(value) < 10 {
		v.AddError(field, displayName+" is too short", "invalid_url")
		return false
	}
	
	return true
}

// Tests

func TestValidator_Basic(t *testing.T) {
	v := NewValidator()
	
	// Test initial state
	assert.False(t, v.HasErrors())
	assert.Empty(t, v.GetErrors())
	
	// Add some errors
	v.AddError("field1", "Error 1", "code1")
	v.AddError("field2", "Error 2", "code2")
	
	assert.True(t, v.HasErrors())
	assert.Len(t, v.GetErrors(), 2)
	
	errors := v.GetErrors()
	assert.Equal(t, "field1", errors[0].Field)
	assert.Equal(t, "Error 1", errors[0].Message)
	assert.Equal(t, "code1", errors[0].Code)
	
	// Test clear
	v.Clear()
	assert.False(t, v.HasErrors())
	assert.Empty(t, v.GetErrors())
}

func TestValidator_Required(t *testing.T) {
	v := NewValidator()
	
	// Valid required field
	assert.True(t, v.ValidateRequired("username", "testuser", "Username"))
	assert.False(t, v.HasErrors())
	
	// Invalid required field (empty)
	v.Clear()
	assert.False(t, v.ValidateRequired("username", "", "Username"))
	assert.True(t, v.HasErrors())
	assert.Equal(t, "required", v.GetErrors()[0].Code)
	
	// Invalid required field (whitespace only)
	v.Clear()
	assert.False(t, v.ValidateRequired("username", "   ", "Username"))
	assert.True(t, v.HasErrors())
}

func TestValidator_Length(t *testing.T) {
	v := NewValidator()
	
	// Valid length
	assert.True(t, v.ValidateMinLength("password", "12345", "Password", 5))
	assert.True(t, v.ValidateMaxLength("username", "test", "Username", 10))
	assert.False(t, v.HasErrors())
	
	// Invalid min length
	v.Clear()
	assert.False(t, v.ValidateMinLength("password", "123", "Password", 5))
	assert.True(t, v.HasErrors())
	assert.Equal(t, "min_length", v.GetErrors()[0].Code)
	
	// Invalid max length
	v.Clear()
	assert.False(t, v.ValidateMaxLength("username", "verylongusername", "Username", 10))
	assert.True(t, v.HasErrors())
	assert.Equal(t, "max_length", v.GetErrors()[0].Code)
}

func TestValidator_Range(t *testing.T) {
	v := NewValidator()
	
	// Valid range
	assert.True(t, v.ValidateRange("threads", "CPU Threads", 4, 1, 16))
	assert.False(t, v.HasErrors())
	
	// Invalid range (too low)
	v.Clear()
	assert.False(t, v.ValidateRange("threads", "CPU Threads", 0, 1, 16))
	assert.True(t, v.HasErrors())
	assert.Equal(t, "range", v.GetErrors()[0].Code)
	
	// Invalid range (too high)
	v.Clear()
	assert.False(t, v.ValidateRange("threads", "CPU Threads", 20, 1, 16))
	assert.True(t, v.HasErrors())
}

func TestValidator_FloatRange(t *testing.T) {
	v := NewValidator()
	
	// Valid float range
	assert.True(t, v.ValidateFloatRange("difficulty", "Difficulty", 1000.5, 1.0, 10000.0))
	assert.False(t, v.HasErrors())
	
	// Invalid float range
	v.Clear()
	assert.False(t, v.ValidateFloatRange("difficulty", "Difficulty", 0.5, 1.0, 10000.0))
	assert.True(t, v.HasErrors())
}

func TestValidator_Alphanumeric(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"worker123", true},
		{"worker_123", true},
		{"worker-123", true},
		{"Worker123", true},
		{"worker@123", false},
		{"worker.123", false},
		{"worker 123", false},
		{"worker#123", false},
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateAlphanumeric("worker", tt.input, "Worker")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_HexString(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"", true},                     // Empty is valid
		{"1234567890abcdef", true},
		{"0x1234567890abcdef", true},
		{"ABCDEF123456", true},
		{"0xABCDEF123456", true},
		{"gghhii", false},
		{"0xgghhii", false},
		{"123@456", false},
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateHexString("hash", tt.input, "Hash")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_Address(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"", false},                                            // Empty
		{"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", true},          // Valid length
		{"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", true}, // Valid length
		{"short", false},                                       // Too short
		{"verylongaddressthatexceedsthemaximumlengthallowedforwalletaddresses", false}, // Too long
		{"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfN@", false},         // Invalid character
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateAddress("address", tt.input, "Address")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_WorkerName(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"", false},           // Empty
		{"ab", false},         // Too short
		{"worker1", true},     // Valid
		{"worker_1", true},    // Valid with underscore
		{"worker-1", true},    // Valid with hyphen
		{"worker.1", true},    // Valid with dot
		{"worker@1", false},   // Invalid character
		{"worker 1", false},   // Invalid space
		{strings.Repeat("a", 65), false}, // Too long
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateWorkerName("worker", tt.input, "Worker")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_Algorithm(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"sha256", true},
		{"SHA256", true},
		{"sha256d", true},
		{"scrypt", true},
		{"ethash", true},
		{"randomx", true},
		{"kawpow", true},
		{"x11", true},
		{"lyra2z", true},
		{"invalid", false},
		{"", false},
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateAlgorithm("algorithm", tt.input, "Algorithm")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_Difficulty(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    float64
		expected bool
	}{
		{1.0, true},
		{1000.5, true},
		{1e6, true},
		{0.0, false},    // Zero
		{-1.0, false},   // Negative
		{1e15, false},   // Too high
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateDifficulty("difficulty", "Difficulty", tt.input)
		assert.Equal(t, tt.expected, result, "Input: %f", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %f", tt.input)
	}
}

func TestValidator_HashRate(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    uint64
		expected bool
	}{
		{1000, true},
		{1e12, true},  // 1 TH/s
		{1e15, true},  // 1 PH/s
		{0, false},    // Zero
		{1e19, false}, // Too high
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateHashRate("hashrate", "Hash Rate", tt.input)
		assert.Equal(t, tt.expected, result, "Input: %d", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %d", tt.input)
	}
}

func TestValidator_PoolFee(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    float64
		expected bool
	}{
		{0.0, true},
		{1.0, true},
		{5.0, true},
		{10.0, true},
		{-1.0, false}, // Negative
		{15.0, false}, // Too high
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidatePoolFee("fee", "Pool Fee", tt.input)
		assert.Equal(t, tt.expected, result, "Input: %f", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %f", tt.input)
	}
}

func TestValidator_PayoutAmount(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    float64
		expected bool
	}{
		{0.001, true},
		{100.0, true},
		{999999.0, true},
		{0.0, false},       // Zero
		{-1.0, false},      // Negative
		{2000000.0, false}, // Too large
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidatePayoutAmount("amount", "Amount", tt.input)
		assert.Equal(t, tt.expected, result, "Input: %f", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %f", tt.input)
	}
}

func TestValidator_Email(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"", true},                    // Empty is valid (optional)
		{"user@example.com", true},
		{"test.email@domain.org", true},
		{"invalid", false},           // No @
		{"@domain.com", false},       // No user part
		{"user@", false},             // No domain part
		{"user@domain", false},       // No TLD
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateEmail("email", tt.input, "Email")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_URL(t *testing.T) {
	v := NewValidator()
	
	tests := []struct {
		input    string
		expected bool
	}{
		{"", false},                           // Empty
		{"http://example.com", true},
		{"https://example.com", true},
		{"https://pool.example.com:3333", true},
		{"ftp://example.com", false},          // Wrong protocol
		{"example.com", false},                // No protocol
		{"http://", false},                    // Too short
	}
	
	for _, tt := range tests {
		v.Clear()
		result := v.ValidateURL("url", tt.input, "URL")
		assert.Equal(t, tt.expected, result, "Input: %s", tt.input)
		assert.Equal(t, !tt.expected, v.HasErrors(), "Input: %s", tt.input)
	}
}

func TestValidator_Complex(t *testing.T) {
	v := NewValidator()
	
	// Test multiple validations at once
	workerName := "test_worker"
	algorithm := "sha256d"
	difficulty := 1000.0
	address := "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
	
	// All should be valid
	v.ValidateWorkerName("worker", workerName, "Worker Name")
	v.ValidateAlgorithm("algorithm", algorithm, "Algorithm")
	v.ValidateDifficulty("difficulty", "Difficulty", difficulty)
	v.ValidateAddress("address", address, "Address")
	
	assert.False(t, v.HasErrors())
	
	// Add an invalid field
	v.ValidateRequired("missing", "", "Missing Field")
	
	assert.True(t, v.HasErrors())
	assert.Len(t, v.GetErrors(), 1)
	assert.Equal(t, "missing", v.GetErrors()[0].Field)
	assert.Equal(t, "required", v.GetErrors()[0].Code)
}

// Benchmark tests

func BenchmarkValidator_Required(b *testing.B) {
	v := NewValidator()
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Clear()
		v.ValidateRequired("field", "value", "Field")
	}
}

func BenchmarkValidator_Alphanumeric(b *testing.B) {
	v := NewValidator()
	value := "worker_123_test"
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Clear()
		v.ValidateAlphanumeric("worker", value, "Worker")
	}
}

func BenchmarkValidator_HexString(b *testing.B) {
	v := NewValidator()
	value := "0x1234567890abcdef1234567890abcdef12345678"
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Clear()
		v.ValidateHexString("hash", value, "Hash")
	}
}

func BenchmarkValidator_Address(b *testing.B) {
	v := NewValidator()
	value := "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Clear()
		v.ValidateAddress("address", value, "Address")
	}
}

func BenchmarkValidator_Multiple(b *testing.B) {
	v := NewValidator()
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Clear()
		v.ValidateRequired("worker", "test_worker", "Worker")
		v.ValidateAlgorithm("algorithm", "sha256d", "Algorithm")
		v.ValidateDifficulty("difficulty", "Difficulty", 1000.0)
		v.ValidateHashRate("hashrate", "Hash Rate", 1000000)
	}
}