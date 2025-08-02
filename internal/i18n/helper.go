package i18n

import (
	"context"
	"fmt"
	"net/http"
	"strings"
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