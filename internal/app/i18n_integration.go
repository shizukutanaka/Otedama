package app

import (
	"context"

	"github.com/shizukutanaka/Otedama/internal/utils"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// InitializeI18n initializes the internationalization system
func (app *Application) InitializeI18n() error {
	config := utils.Config{
		DefaultLanguage:    "en",
		FallbackLanguage:   "en",
		SupportedLanguages: []string{"en", "ja", "zh", "ko", "es", "fr", "de", "ru", "ar", "pt"},
		TranslationsPath:   "translations",
	}

	manager, err := utils.NewManager(config, app.logger)
	if err != nil {
		return err
	}

	// Set global manager for easy access
	utils.SetGlobalManager(manager)

	app.logger.Info("I18n system initialized",
		zap.String("default_language", config.DefaultLanguage),
		zap.Strings("supported_languages", manager.GetSupportedLanguages()),
	)

	return nil
}

// LogWithI18n logs a message with internationalization
func (app *Application) LogWithI18n(ctx context.Context, level zapcore.Level, key string, fields ...zap.Field) {
	msg := utils.TContext(ctx, key)
	
	switch level {
	case zapcore.DebugLevel:
		app.logger.Debug(msg, fields...)
	case zapcore.InfoLevel:
		app.logger.Info(msg, fields...)
	case zapcore.WarnLevel:
		app.logger.Warn(msg, fields...)
	case zapcore.ErrorLevel:
		app.logger.Error(msg, fields...)
	default:
		app.logger.Info(msg, fields...)
	}
}

// Example usage in application code
func (app *Application) exampleI18nUsage() {
	// Simple translation
	welcomeMsg := utils.T("message.welcome")
	app.logger.Info(welcomeMsg)

	// Translation with arguments
	versionMsg := utils.T("app.version", "2.1.1")
	app.logger.Info(versionMsg)

	// Format hashrate with localization
	hashrate := utils.FormatHashrate(1234567890)
	hashrateMsg := utils.T("mining.hashrate", hashrate)
	app.logger.Info(hashrateMsg)

	// Format duration
	uptime := utils.FormatDuration(3661) // 1 hour, 1 minute, 1 second
	uptimeMsg := utils.T("mining.uptime", uptime)
	app.logger.Info(uptimeMsg)

	// Use context for language-specific translation
	ctx := utils.WithLanguage(context.Background(), "ja")
	japaneseMsg := utils.TContext(ctx, "message.welcome")
	app.logger.Info("Japanese welcome", zap.String("message", japaneseMsg))

	// Pluralization
	shares := 5
	sharesMsg := utils.T("mining.shares.accepted", shares)
	app.logger.Info(sharesMsg)
}

// LocalizedError represents an error with localization support
type LocalizedError struct {
	Key    string
	Args   []interface{}
	Cause  error
}

// Error implements the error interface
func (e LocalizedError) Error() string {
	return utils.T(e.Key, e.Args...)
}

// Unwrap returns the underlying error
func (e LocalizedError) Unwrap() error {
	return e.Cause
}

// NewLocalizedError creates a new localized error
func NewLocalizedError(key string, args ...interface{}) LocalizedError {
	return LocalizedError{
		Key:  key,
		Args: args,
	}
}

// NewLocalizedErrorWithCause creates a new localized error with cause
func NewLocalizedErrorWithCause(cause error, key string, args ...interface{}) LocalizedError {
	return LocalizedError{
		Key:   key,
		Args:  args,
		Cause: cause,
	}
}

// Common localized errors
var (
	ErrConnectionFailed = NewLocalizedError("error.connection")
	ErrAuthFailed       = NewLocalizedError("error.authentication")
	ErrInvalidInput     = NewLocalizedError("error.invalid_input")
	ErrNotFound         = NewLocalizedError("error.not_found")
	ErrPermissionDenied = NewLocalizedError("error.permission_denied")
)

// LocalizeStatus returns localized status string
func LocalizeStatus(status string) string {
	return utils.T("status." + status)
}

// LocalizeAlgorithm returns localized algorithm name
func LocalizeAlgorithm(algo string) string {
	return utils.T("algorithm." + algo)
}

// LocalizeAction returns localized action string
func LocalizeAction(action string) string {
	return utils.T("action." + action)
}