// Package i18n provides internationalization support for the Otedama system.
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"go.uber.org/zap"
)

//go:embed translations/*.json
var translationsFS embed.FS

// Manager manages internationalization
type Manager struct {
	logger         *zap.Logger
	translations   map[string]map[string]string
	defaultLang    string
	currentLang    string
	fallbackLang   string
	mu             sync.RWMutex
}

// Config defines i18n configuration
type Config struct {
	DefaultLanguage   string   `yaml:"default_language" default:"en"`
	FallbackLanguage  string   `yaml:"fallback_language" default:"en"`
	SupportedLanguages []string `yaml:"supported_languages"`
	TranslationsPath  string   `yaml:"translations_path" default:"translations"`
}

// NewManager creates a new i18n manager
func NewManager(config Config, logger *zap.Logger) (*Manager, error) {
	if config.DefaultLanguage == "" {
		config.DefaultLanguage = "en"
	}
	if config.FallbackLanguage == "" {
		config.FallbackLanguage = "en"
	}

	m := &Manager{
		logger:        logger,
		translations:  make(map[string]map[string]string),
		defaultLang:   config.DefaultLanguage,
		currentLang:   config.DefaultLanguage,
		fallbackLang:  config.FallbackLanguage,
	}

	// Load translations
	if err := m.loadTranslations(config); err != nil {
		return nil, fmt.Errorf("failed to load translations: %w", err)
	}

	logger.Info("I18n manager initialized",
		zap.String("default_language", config.DefaultLanguage),
		zap.String("fallback_language", config.FallbackLanguage),
		zap.Int("loaded_languages", len(m.translations)),
	)

	return m, nil
}

// loadTranslations loads all translation files
func (m *Manager) loadTranslations(config Config) error {
	// Load embedded translations first
	entries, err := translationsFS.ReadDir("translations")
	if err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
				lang := strings.TrimSuffix(entry.Name(), ".json")
				data, err := translationsFS.ReadFile("translations/" + entry.Name())
				if err != nil {
					m.logger.Error("Failed to read embedded translation",
						zap.String("file", entry.Name()),
						zap.Error(err),
					)
					continue
				}

				if err := m.loadTranslationData(lang, data); err != nil {
					m.logger.Error("Failed to load embedded translation",
						zap.String("language", lang),
						zap.Error(err),
					)
				}
			}
		}
	}

	// Load external translations if path exists
	if config.TranslationsPath != "" {
		if _, err := os.Stat(config.TranslationsPath); err == nil {
			files, err := filepath.Glob(filepath.Join(config.TranslationsPath, "*.json"))
			if err != nil {
				return fmt.Errorf("failed to list translation files: %w", err)
			}

			for _, file := range files {
				lang := strings.TrimSuffix(filepath.Base(file), ".json")
				data, err := os.ReadFile(file)
				if err != nil {
					m.logger.Error("Failed to read translation file",
						zap.String("file", file),
						zap.Error(err),
					)
					continue
				}

				if err := m.loadTranslationData(lang, data); err != nil {
					m.logger.Error("Failed to load translation",
						zap.String("language", lang),
						zap.Error(err),
					)
				}
			}
		}
	}

	// Ensure we have at least the fallback language
	if _, exists := m.translations[m.fallbackLang]; !exists {
		m.translations[m.fallbackLang] = getDefaultTranslations()
	}

	return nil
}

// loadTranslationData loads translation data for a language
func (m *Manager) loadTranslationData(lang string, data []byte) error {
	var translations map[string]string
	if err := json.Unmarshal(data, &translations); err != nil {
		return fmt.Errorf("failed to parse translation data: %w", err)
	}

	m.mu.Lock()
	m.translations[lang] = translations
	m.mu.Unlock()

	m.logger.Debug("Loaded translations",
		zap.String("language", lang),
		zap.Int("keys", len(translations)),
	)

	return nil
}

// SetLanguage sets the current language
func (m *Manager) SetLanguage(lang string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.translations[lang]; !exists {
		return fmt.Errorf("unsupported language: %s", lang)
	}

	m.currentLang = lang
	return nil
}

// GetLanguage returns the current language
func (m *Manager) GetLanguage() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.currentLang
}

// T translates a key to the current language
func (m *Manager) T(key string, args ...interface{}) string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// Try current language
	if trans, exists := m.translations[m.currentLang]; exists {
		if text, ok := trans[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(text, args...)
			}
			return text
		}
	}

	// Try fallback language
	if trans, exists := m.translations[m.fallbackLang]; exists {
		if text, ok := trans[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(text, args...)
			}
			return text
		}
	}

	// Return key if no translation found
	return key
}

// Translate translates a key to a specific language
func (m *Manager) Translate(lang, key string, args ...interface{}) string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if trans, exists := m.translations[lang]; exists {
		if text, ok := trans[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(text, args...)
			}
			return text
		}
	}

	// Try fallback
	if trans, exists := m.translations[m.fallbackLang]; exists {
		if text, ok := trans[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(text, args...)
			}
			return text
		}
	}

	return key
}

// GetSupportedLanguages returns list of supported languages
func (m *Manager) GetSupportedLanguages() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	languages := make([]string, 0, len(m.translations))
	for lang := range m.translations {
		languages = append(languages, lang)
	}
	return languages
}

// HasLanguage checks if a language is supported
func (m *Manager) HasLanguage(lang string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, exists := m.translations[lang]
	return exists
}

// AddTranslation adds or updates a translation
func (m *Manager) AddTranslation(lang, key, value string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.translations[lang]; !exists {
		m.translations[lang] = make(map[string]string)
	}
	m.translations[lang][key] = value
}

// GetTranslations returns all translations for a language
func (m *Manager) GetTranslations(lang string) map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if trans, exists := m.translations[lang]; exists {
		// Return a copy to prevent external modification
		copy := make(map[string]string, len(trans))
		for k, v := range trans {
			copy[k] = v
		}
		return copy
	}
	return nil
}

// Pluralize handles pluralization
func (m *Manager) Pluralize(key string, count int, args ...interface{}) string {
	pluralKey := key
	if count == 1 {
		pluralKey = key + ".singular"
	} else {
		pluralKey = key + ".plural"
	}

	// Try plural form first
	text := m.T(pluralKey, append([]interface{}{count}, args...)...)
	if text != pluralKey {
		return text
	}

	// Fallback to base key
	return m.T(key, append([]interface{}{count}, args...)...)
}

// Format formats a number according to locale
func (m *Manager) FormatNumber(n interface{}) string {
	// Simple implementation - can be enhanced with proper locale formatting
	return fmt.Sprintf("%v", n)
}

// FormatCurrency formats currency according to locale
func (m *Manager) FormatCurrency(amount float64, currency string) string {
	// Simple implementation - can be enhanced with proper locale formatting
	return fmt.Sprintf("%.2f %s", amount, currency)
}

// FormatDate formats date according to locale
func (m *Manager) FormatDate(t interface{}) string {
	// Simple implementation - can be enhanced with proper locale formatting
	return fmt.Sprintf("%v", t)
}

// getDefaultTranslations returns default English translations
func getDefaultTranslations() map[string]string {
	return map[string]string{
		// General
		"app.name":        "Otedama P2P Mining Pool",
		"app.version":     "Version %s",
		"app.description": "Decentralized mining pool with zero-knowledge proof authentication",
		
		// Status
		"status.running":     "Running",
		"status.stopped":     "Stopped",
		"status.starting":    "Starting",
		"status.stopping":    "Stopping",
		"status.error":       "Error",
		"status.connected":   "Connected",
		"status.disconnected": "Disconnected",
		
		// Mining
		"mining.hashrate":        "Hash Rate: %s",
		"mining.difficulty":      "Difficulty: %s",
		"mining.shares.accepted": "Accepted Shares: %d",
		"mining.shares.rejected": "Rejected Shares: %d",
		"mining.algorithm":       "Algorithm: %s",
		"mining.workers":         "Workers: %d",
		"mining.temperature":     "Temperature: %d°C",
		"mining.power":          "Power: %d W",
		
		// Pool
		"pool.fee":         "Pool Fee: %.2f%%",
		"pool.peers":       "Connected Peers: %d",
		"pool.blocks.found": "Blocks Found: %d",
		"pool.payout.min":  "Minimum Payout: %s",
		
		// Errors
		"error.generic":           "An error occurred",
		"error.connection":        "Connection error",
		"error.authentication":    "Authentication failed",
		"error.invalid_input":     "Invalid input",
		"error.not_found":         "Not found",
		"error.permission_denied": "Permission denied",
		
		// Actions
		"action.start":   "Start",
		"action.stop":    "Stop",
		"action.restart": "Restart",
		"action.save":    "Save",
		"action.cancel":  "Cancel",
		"action.confirm": "Confirm",
		"action.delete":  "Delete",
		"action.edit":    "Edit",
		"action.refresh": "Refresh",
		
		// Time
		"time.seconds": "%d seconds",
		"time.minutes": "%d minutes",
		"time.hours":   "%d hours",
		"time.days":    "%d days",
		
		// Messages
		"message.welcome":      "Welcome to Otedama P2P Mining Pool",
		"message.mining_started": "Mining started successfully",
		"message.mining_stopped": "Mining stopped",
		"message.settings_saved": "Settings saved successfully",
		"message.connecting":    "Connecting to pool...",
		"message.connected":     "Connected to pool",
	}
}