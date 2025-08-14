package utils

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Global i18n manager instance
var globalManager *Manager

// SetGlobalManager sets the global i18n manager
func SetGlobalManager(m *Manager) {
	globalManager = m
}

// GetGlobalManager returns the global i18n manager
func GetGlobalManager() *Manager {
	return globalManager
}

// T translates using the global manager
func T(key string, args ...interface{}) string {
	if globalManager == nil {
		return key
	}
	return globalManager.T(key, args...)
}

// Translate translates to a specific language using the global manager
func Translate(lang, key string, args ...interface{}) string {
	if globalManager == nil {
		return key
	}
	return globalManager.Translate(lang, key, args...)
}

// Context key for storing language preference
type contextKey string

const langContextKey contextKey = "language"

// WithLanguage returns a context with language preference
func WithLanguage(ctx context.Context, lang string) context.Context {
	return context.WithValue(ctx, langContextKey, lang)
}

// LanguageFromContext gets language preference from context
func LanguageFromContext(ctx context.Context) string {
	if lang, ok := ctx.Value(langContextKey).(string); ok {
		return lang
	}
	if globalManager != nil {
		return globalManager.GetLanguage()
	}
	return "en"
}

// TContext translates using language from context
func TContext(ctx context.Context, key string, args ...interface{}) string {
	if globalManager == nil {
		return key
	}
	lang := LanguageFromContext(ctx)
	return globalManager.Translate(lang, key, args...)
}

// HTTPMiddleware creates HTTP middleware for language detection
func HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lang := DetectLanguage(r)
		ctx := WithLanguage(r.Context(), lang)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// DetectLanguage detects language from HTTP request
func DetectLanguage(r *http.Request) string {
	// Check query parameter
	if lang := r.URL.Query().Get("lang"); lang != "" {
		if globalManager != nil && globalManager.HasLanguage(lang) {
			return lang
		}
	}
	
	// Check cookie
	if cookie, err := r.Cookie("language"); err == nil && cookie.Value != "" {
		if globalManager != nil && globalManager.HasLanguage(cookie.Value) {
			return cookie.Value
		}
	}
	
	// Check Accept-Language header
	acceptLang := r.Header.Get("Accept-Language")
	if acceptLang != "" {
		langs := ParseAcceptLanguage(acceptLang)
		if globalManager != nil {
			for _, lang := range langs {
				if globalManager.HasLanguage(lang) {
					return lang
				}
			}
		}
	}
	
	// Return default
	if globalManager != nil {
		return globalManager.GetLanguage()
	}
	return "en"
}

// ParseAcceptLanguage parses Accept-Language header
func ParseAcceptLanguage(header string) []string {
	var langs []string
	parts := strings.Split(header, ",")
	
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if idx := strings.Index(part, ";"); idx != -1 {
			part = part[:idx]
		}
		
		// Convert to simple language code
		if idx := strings.Index(part, "-"); idx != -1 {
			part = part[:idx]
		}
		
		if part != "" && !contains(langs, part) {
			langs = append(langs, strings.ToLower(part))
		}
	}
	
	return langs
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// StringContains checks if a string slice contains an item
func StringContains(slice []string, item string) bool {
	return contains(slice, item)
}

// GenerateRandomBytes generates random bytes of specified length
func GenerateRandomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// GenerateRandomHex generates random hex string of specified byte length
func GenerateRandomHex(n int) (string, error) {
	bytes, err := GenerateRandomBytes(n)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// GenerateSecureToken generates a secure random token
func GenerateSecureToken(length int) (string, error) {
	return GenerateRandomHex(length)
}

// IsValidIPAddress checks if string is valid IP address
func IsValidIPAddress(ip string) bool {
	return net.ParseIP(ip) != nil
}

// IsValidPort checks if port number is valid
func IsValidPort(port int) bool {
	return port > 0 && port <= 65535
}

// ParseAddress parses address string into host and port
func ParseAddress(address string) (host string, port string, err error) {
	host, port, err = net.SplitHostPort(address)
	if err != nil {
		// Try to parse as IP without port
		if IsValidIPAddress(address) {
			return address, "", nil
		}
		return "", "", fmt.Errorf("invalid address format: %s", address)
	}
	return host, port, nil
}

// FileExists checks if file exists
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return !os.IsNotExist(err)
}

// EnsureDir ensures directory exists
func EnsureDir(path string) error {
	return os.MkdirAll(path, 0755)
}

// GetExecutablePath returns the path of the current executable
func GetExecutablePath() (string, error) {
	ex, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(ex), nil
}

// GetHomeDir returns user home directory
func GetHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return home, nil
}

// GetSystemInfo returns basic system information
func GetSystemInfo() map[string]interface{} {
	return map[string]interface{}{
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"cpu_count":    runtime.NumCPU(),
		"goroutines":   runtime.NumGoroutine(),
	}
}

// RandomInt generates random integer in range [min, max]
func RandomInt(min, max int64) (int64, error) {
	if min > max {
		return 0, fmt.Errorf("min cannot be greater than max")
	}
	
	diff := max - min + 1
	n, err := rand.Int(rand.Reader, big.NewInt(diff))
	if err != nil {
		return 0, err
	}
	
	return n.Int64() + min, nil
}

// Retry executes function with exponential backoff
func Retry(attempts int, delay time.Duration, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		err = fn()
		if err == nil {
			return nil
		}
		
		if i < attempts-1 {
			time.Sleep(delay)
			delay *= 2 // Exponential backoff
		}
	}
	return fmt.Errorf("after %d attempts: %w", attempts, err)
}

// MinInt returns minimum of two integers
func MinInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// MaxInt returns maximum of two integers
func MaxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// MinInt64 returns minimum of two int64
func MinInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// MaxInt64 returns maximum of two int64
func MaxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ClampInt clamps integer value between min and max
func ClampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// SafeDivide performs safe division avoiding divide by zero
func SafeDivide(numerator, denominator float64) float64 {
	if denominator == 0 {
		return 0
	}
	return numerator / denominator
}

// FormatHashrate formats hashrate with appropriate unit
func FormatHashrate(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"}
	unitIndex := 0
	
	for hashrate >= 1000 && unitIndex < len(units)-1 {
		hashrate /= 1000
		unitIndex++
	}
	
	unitKey := "unit.hashrate." + strings.ToLower(strings.TrimSuffix(units[unitIndex], "/s"))
	unit := T(unitKey)
	if unit == unitKey {
		unit = units[unitIndex]
	}
	
	if hashrate >= 100 {
		return fmt.Sprintf("%.0f %s", hashrate, unit)
	} else if hashrate >= 10 {
		return fmt.Sprintf("%.1f %s", hashrate, unit)
	} else {
		return fmt.Sprintf("%.2f %s", hashrate, unit)
	}
}

// FormatDuration formats duration in human-readable form
func FormatDuration(seconds int64) string {
	if seconds < 60 {
		return T("time.seconds", seconds)
	}
	
	minutes := seconds / 60
	if minutes < 60 {
		return T("time.minutes", minutes)
	}
	
	hours := minutes / 60
	if hours < 24 {
		return T("time.hours", hours)
	}
	
	days := hours / 24
	return T("time.days", days)
}

// FormatNumber formats number according to locale
func FormatNumber(n interface{}) string {
	if globalManager != nil {
		return globalManager.FormatNumber(n)
	}
	return fmt.Sprintf("%v", n)
}

// FormatCurrency formats currency according to locale
func FormatCurrency(amount float64, currency string) string {
	if globalManager != nil {
		return globalManager.FormatCurrency(amount, currency)
	}
	return fmt.Sprintf("%.2f %s", amount, currency)
}

// FormatDate formats date according to locale
func FormatDate(t interface{}) string {
	if globalManager != nil {
		return globalManager.FormatDate(t)
	}
	return fmt.Sprintf("%v", t)
}

// LanguageInfo represents language information
type LanguageInfo struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	NativeName  string `json:"native_name"`
	IsRTL       bool   `json:"is_rtl"`
}

// GetLanguageInfo returns information about supported languages
func GetLanguageInfo() []LanguageInfo {
	return []LanguageInfo{
		{Code: "en", Name: "English", NativeName: "English", IsRTL: false},
		{Code: "ja", Name: "Japanese", NativeName: "日本語", IsRTL: false},
		{Code: "zh", Name: "Chinese", NativeName: "中文", IsRTL: false},
		{Code: "ko", Name: "Korean", NativeName: "한국어", IsRTL: false},
		{Code: "es", Name: "Spanish", NativeName: "Español", IsRTL: false},
		{Code: "fr", Name: "French", NativeName: "Français", IsRTL: false},
		{Code: "de", Name: "German", NativeName: "Deutsch", IsRTL: false},
		{Code: "ru", Name: "Russian", NativeName: "Русский", IsRTL: false},
		{Code: "ar", Name: "Arabic", NativeName: "العربية", IsRTL: true},
		{Code: "pt", Name: "Portuguese", NativeName: "Português", IsRTL: false},
	}
}

// GetTimestamp returns current Unix timestamp
func GetTimestamp() int64 {
	return time.Now().Unix()
}

// GetMillisTimestamp returns current Unix timestamp in milliseconds
func GetMillisTimestamp() int64 {
	return time.Now().UnixMilli()
}

// FormatBytes formats bytes into human readable format
func FormatBytes(bytes int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	unitIndex := 0
	value := float64(bytes)
	
	for value >= 1024 && unitIndex < len(units)-1 {
		value /= 1024
		unitIndex++
	}
	
	if value >= 100 {
		return fmt.Sprintf("%.0f %s", value, units[unitIndex])
	} else if value >= 10 {
		return fmt.Sprintf("%.1f %s", value, units[unitIndex])
	} else {
		return fmt.Sprintf("%.2f %s", value, units[unitIndex])
	}
}

// ParseBool parses string to bool with default value
func ParseBool(s string, defaultValue bool) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes", "on", "enabled":
		return true
	case "false", "0", "no", "off", "disabled":
		return false
	default:
		return defaultValue
	}
}

// SanitizeString removes potentially dangerous characters
func SanitizeString(s string) string {
	// Remove null bytes and control characters
	var result strings.Builder
	for _, r := range s {
		if r >= 32 && r != 127 { // Printable characters
			result.WriteRune(r)
		}
	}
	return strings.TrimSpace(result.String())
}

// TruncateString truncates string to specified length
func TruncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}