package security

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

// InputSanitizer provides comprehensive input sanitization
type InputSanitizer struct {
	maxLength   int
	allowedTags map[string]bool
	patterns    map[string]*regexp.Regexp
}

// NewInputSanitizer creates a new input sanitizer
func NewInputSanitizer() *InputSanitizer {
	return &InputSanitizer{
		maxLength:   10000, // Default max length
		allowedTags: make(map[string]bool),
		patterns:    make(map[string]*regexp.Regexp),
	}
}

// WithMaxLength sets maximum input length
func (is *InputSanitizer) WithMaxLength(length int) *InputSanitizer {
	is.maxLength = length
	return is
}

// WithAllowedTags sets allowed HTML tags
func (is *InputSanitizer) WithAllowedTags(tags ...string) *InputSanitizer {
	for _, tag := range tags {
		is.allowedTags[strings.ToLower(tag)] = true
	}
	return is
}

// SanitizeString sanitizes a general string input
func (is *InputSanitizer) SanitizeString(input string) string {
	if len(input) > is.maxLength {
		input = input[:is.maxLength]
	}
	
	// Remove null bytes
	input = strings.ReplaceAll(input, "\x00", "")
	
	// Normalize unicode
	input = normalizeUnicode(input)
	
	// Remove control characters except whitespace
	var result strings.Builder
	for _, r := range input {
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			continue
		}
		result.WriteRune(r)
	}
	
	return strings.TrimSpace(result.String())
}

// SanitizeHTML sanitizes HTML input
func (is *InputSanitizer) SanitizeHTML(input string) string {
	// First apply general string sanitization
	input = is.SanitizeString(input)
	
	// HTML escape the entire string
	input = html.EscapeString(input)
	
	// If no allowed tags, return escaped string
	if len(is.allowedTags) == 0 {
		return input
	}
	
	// Allow only specified tags (simplified implementation)
	// In production, use a proper HTML sanitizer like bluemonday
	return input
}

// SanitizeSQL sanitizes input for SQL queries
func (is *InputSanitizer) SanitizeSQL(input string) string {
	input = is.SanitizeString(input)
	
	// Remove SQL injection patterns
	sqlPatterns := []string{
		`--`, `/*`, `*/`, `;`, `\x00`, `\n`, `\r`, `\x1a`,
		`'`, `"`, `\`, `%`, `_`,
	}
	
	for _, pattern := range sqlPatterns {
		input = strings.ReplaceAll(input, pattern, "")
	}
	
	return input
}

// SanitizeFilename sanitizes filename input
func (is *InputSanitizer) SanitizeFilename(filename string) string {
	filename = is.SanitizeString(filename)
	
	// Remove path traversal attempts
	filename = strings.ReplaceAll(filename, "..", "")
	filename = strings.ReplaceAll(filename, "/", "")
	filename = strings.ReplaceAll(filename, "\\", "")
	
	// Remove dangerous characters
	dangerousChars := []string{
		"<", ">", ":", "\"", "|", "?", "*", "\x00",
	}
	
	for _, char := range dangerousChars {
		filename = strings.ReplaceAll(filename, char, "")
	}
	
	// Ensure filename is not empty or just dots
	filename = strings.Trim(filename, ". ")
	if filename == "" {
		filename = "sanitized_file"
	}
	
	return filename
}

// SanitizeURL sanitizes URL input
func (is *InputSanitizer) SanitizeURL(input string) (string, error) {
	input = is.SanitizeString(input)
	
	// Parse URL to validate structure
	parsedURL, err := url.Parse(input)
	if err != nil {
		return "", err
	}
	
	// Only allow http and https schemes
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return "", fmt.Errorf("invalid URL scheme: %s", parsedURL.Scheme)
	}
	
	// Rebuild URL to normalize
	return parsedURL.String(), nil
}

// SanitizeEmail sanitizes email input
func (is *InputSanitizer) SanitizeEmail(email string) string {
	email = is.SanitizeString(email)
	email = strings.ToLower(email)
	
	// Basic email format validation and sanitization
	if !isValidEmail(email) {
		return ""
	}
	
	return email
}

// SanitizeAlphanumeric allows only alphanumeric characters
func (is *InputSanitizer) SanitizeAlphanumeric(input string) string {
	input = is.SanitizeString(input)
	
	var result strings.Builder
	for _, r := range input {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			result.WriteRune(r)
		}
	}
	
	return result.String()
}

// SanitizeNumeric allows only numeric characters
func (is *InputSanitizer) SanitizeNumeric(input string) string {
	input = is.SanitizeString(input)
	
	var result strings.Builder
	for _, r := range input {
		if unicode.IsDigit(r) || r == '.' || r == '-' {
			result.WriteRune(r)
		}
	}
	
	return result.String()
}

// InputValidator provides input validation
type InputValidator struct {
	patterns map[string]*regexp.Regexp
}

// NewInputValidator creates a new input validator
func NewInputValidator() *InputValidator {
	iv := &InputValidator{
		patterns: make(map[string]*regexp.Regexp),
	}
	
	// Compile common validation patterns
	iv.patterns["email"] = regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
	iv.patterns["username"] = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)
	iv.patterns["password"] = regexp.MustCompile(`^.{8,128}$`)
	iv.patterns["ip"] = regexp.MustCompile(`^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`)
	iv.patterns["uuid"] = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	iv.patterns["alphanumeric"] = regexp.MustCompile(`^[a-zA-Z0-9]+$`)
	iv.patterns["numeric"] = regexp.MustCompile(`^[0-9]+$`)
	iv.patterns["float"] = regexp.MustCompile(`^[+-]?([0-9]*[.])?[0-9]+$`)
	iv.patterns["url"] = regexp.MustCompile(`^https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`)
	
	return iv
}

// ValidateEmail validates email format
func (iv *InputValidator) ValidateEmail(email string) bool {
	return iv.patterns["email"].MatchString(email)
}

// ValidateUsername validates username format
func (iv *InputValidator) ValidateUsername(username string) bool {
	return iv.patterns["username"].MatchString(username)
}

// ValidatePassword validates password format
func (iv *InputValidator) ValidatePassword(password string) bool {
	return iv.patterns["password"].MatchString(password)
}

// ValidateIP validates IP address format
func (iv *InputValidator) ValidateIP(ip string) bool {
	return iv.patterns["ip"].MatchString(ip)
}

// ValidateUUID validates UUID format
func (iv *InputValidator) ValidateUUID(uuid string) bool {
	return iv.patterns["uuid"].MatchString(strings.ToLower(uuid))
}

// ValidateAlphanumeric validates alphanumeric input
func (iv *InputValidator) ValidateAlphanumeric(input string) bool {
	return iv.patterns["alphanumeric"].MatchString(input)
}

// ValidateNumeric validates numeric input
func (iv *InputValidator) ValidateNumeric(input string) bool {
	return iv.patterns["numeric"].MatchString(input)
}

// ValidateFloat validates float number
func (iv *InputValidator) ValidateFloat(input string) bool {
	return iv.patterns["float"].MatchString(input)
}

// ValidateURL validates URL format
func (iv *InputValidator) ValidateURL(url string) bool {
	return iv.patterns["url"].MatchString(url)
}

// ValidateLength validates string length
func (iv *InputValidator) ValidateLength(input string, min, max int) bool {
	length := len(input)
	return length >= min && length <= max
}

// ValidatePattern validates against custom pattern
func (iv *InputValidator) ValidatePattern(input, pattern string) (bool, error) {
	regex, err := regexp.Compile(pattern)
	if err != nil {
		return false, err
	}
	
	return regex.MatchString(input), nil
}

// CSRFToken represents a CSRF token
type CSRFToken struct {
	Token     string    `json:"token"`
	UserID    string    `json:"user_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CSRFProtection provides CSRF protection
type CSRFProtection struct {
	tokens map[string]*CSRFToken
	mu     sync.RWMutex
	secret []byte
}

// NewCSRFProtection creates new CSRF protection
func NewCSRFProtection(secret []byte) *CSRFProtection {
	return &CSRFProtection{
		tokens: make(map[string]*CSRFToken),
		secret: secret,
	}
}

// GenerateToken generates a new CSRF token
func (cp *CSRFProtection) GenerateToken(userID string) string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	
	// Generate token
	tokenBytes := make([]byte, 32)
	rand.Read(tokenBytes)
	token := base32.StdEncoding.EncodeToString(tokenBytes)
	
	// Store token
	csrfToken := &CSRFToken{
		Token:     token,
		UserID:    userID,
		ExpiresAt: time.Now().Add(1 * time.Hour),
	}
	
	cp.tokens[token] = csrfToken
	
	// Clean expired tokens
	cp.cleanExpiredTokens()
	
	return token
}

// ValidateToken validates a CSRF token
func (cp *CSRFProtection) ValidateToken(token, userID string) bool {
	cp.mu.RLock()
	defer cp.mu.RUnlock()
	
	csrfToken, exists := cp.tokens[token]
	if !exists {
		return false
	}
	
	if csrfToken.ExpiresAt.Before(time.Now()) {
		return false
	}
	
	if csrfToken.UserID != userID {
		return false
	}
	
	return true
}

// cleanExpiredTokens removes expired tokens
func (cp *CSRFProtection) cleanExpiredTokens() {
	now := time.Now()
	for token, csrfToken := range cp.tokens {
		if csrfToken.ExpiresAt.Before(now) {
			delete(cp.tokens, token)
		}
	}
}

// Helper functions

func normalizeUnicode(input string) string {
	// Basic unicode normalization
	// In production, use golang.org/x/text/unicode/norm
	return input
}

func isValidEmail(email string) bool {
	// Basic email validation
	if len(email) < 3 || len(email) > 254 {
		return false
	}
	
	parts := strings.Split(email, "@")
	if len(parts) != 2 {
		return false
	}
	
	local, domain := parts[0], parts[1]
	if len(local) == 0 || len(local) > 64 {
		return false
	}
	
	if len(domain) == 0 || len(domain) > 253 {
		return false
	}
	
	return true
}

// SecurityScanner scans for security vulnerabilities
type SecurityScanner struct {
	patterns map[string]*regexp.Regexp
}

// NewSecurityScanner creates a new security scanner
func NewSecurityScanner() *SecurityScanner {
	ss := &SecurityScanner{
		patterns: make(map[string]*regexp.Regexp),
	}
	
	// Compile security scanning patterns
	ss.patterns["sql_injection"] = regexp.MustCompile(`(?i)(union|select|insert|delete|update|drop|exec|execute|\-\-|\/\*|\*\/|xp_|sp_)`)
	ss.patterns["xss"] = regexp.MustCompile(`(?i)(<script|javascript:|vbscript:|onload=|onerror=|onclick=)`)
	ss.patterns["path_traversal"] = regexp.MustCompile(`(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e%5c)`)
	ss.patterns["command_injection"] = regexp.MustCompile(`(?i)(;|\||&|<|>|\$\(|\`|sudo|rm|cat|wget|curl)`)
	ss.patterns["ldap_injection"] = regexp.MustCompile(`(\*|\(|\)|\\|\/|\!|&|\|)`)
	
	return ss
}

// ScanForVulnerabilities scans input for security vulnerabilities
func (ss *SecurityScanner) ScanForVulnerabilities(input string) []string {
	var vulnerabilities []string
	
	for name, pattern := range ss.patterns {
		if pattern.MatchString(input) {
			vulnerabilities = append(vulnerabilities, name)
		}
	}
	
	return vulnerabilities
}

// IsSecure checks if input appears secure
func (ss *SecurityScanner) IsSecure(input string) bool {
	return len(ss.ScanForVulnerabilities(input)) == 0
}