package logging

import (
	"go.uber.org/zap/zapcore"
)

// Config defines all settings for logging.
type Config struct {
	// Level is the minimum log level that will be captured.
	Level string `yaml:"level" default:"info"`

	// Format specifies the log output format. Can be "json" or "console".
	Format string `yaml:"format" default:"json"`

	// OutputPath is the primary destination for log output.
	// "stdout", "stderr", or a file path.
	OutputPath string `yaml:"output_path" default:"stdout"`

	// ErrorOutputPath is the destination for error logs.
	// "stdout", "stderr", or a file path.
	ErrorOutputPath string `yaml:"error_output_path" default:"stderr"`

	// Rotation defines the configuration for log file rotation.
	Rotation RotationConfig `yaml:"rotation"`

	// ModuleLevels allows setting specific log levels for different modules.
	ModuleLevels map[string]string `yaml:"module_levels"`

	// EnableCaller determines if the caller information (file and line number) is included in logs.
	EnableCaller bool `yaml:"enable_caller" default:"true"`

	// EnableStacktrace determines if stack traces are automatically logged for errors.
	EnableStacktrace bool `yaml:"enable_stacktrace" default:"true"`

	// Development enables development-friendly logging (e.g., colored console output).
	Development bool `yaml:"development" default:"false"`

	// Sampling configures log sampling to reduce log volume.
	Sampling *SamplingConfig `yaml:"sampling"`

	// InitialFields are fields that are added to all log entries.
	InitialFields map[string]interface{} `yaml:"initial_fields"`
}

// RotationConfig defines the settings for log file rotation.
type RotationConfig struct {
	// MaxSize is the maximum size in megabytes of the log file before it gets rotated.
	MaxSize int `yaml:"max_size_mb" default:"100"`

	// MaxAge is the maximum number of days to retain old log files.
	MaxAge int `yaml:"max_age_days" default:"30"`

	// MaxBackups is the maximum number of old log files to retain.
	MaxBackups int `yaml:"max_backups" default:"10"`

	// Compress determines if the rotated log files should be compressed.
	Compress bool `yaml:"compress" default:"true"`

	// LocalTime uses local time for formatting timestamps in rotated files.
	LocalTime bool `yaml:"local_time" default:"true"`
}

// SamplingConfig defines the settings for log sampling.
type SamplingConfig struct {
	// Enabled activates sampling.
	Enabled bool `yaml:"enabled" default:"false"`
	// Initial is the number of messages to log per second before sampling kicks in.
	Initial int `yaml:"initial" default:"100"`
	// Thereafter is the number of messages to log per second after the initial burst.
	Thereafter int `yaml:"thereafter" default:"100"`
}

// DefaultConfig returns a new Config with sensible default values.
func DefaultConfig() *Config {
	return &Config{
		Level:           "info",
		Format:          "json",
		OutputPath:      "logs/otedama.log",
		ErrorOutputPath: "logs/otedama_error.log",
		Rotation: RotationConfig{
			MaxSize:    100,
			MaxAge:     30,
			MaxBackups: 10,
			Compress:   true,
			LocalTime:  true,
		},
		ModuleLevels:     make(map[string]string),
		EnableCaller:     true,
		EnableStacktrace: true,
		Development:      false,
		Sampling: &SamplingConfig{
			Enabled:    true,
			Initial:    100,
			Thereafter: 100,
		},
		InitialFields: map[string]interface{}{
			"service": "otedama",
		},
	}
}

// buildEncoderConfig creates a zapcore.EncoderConfig from the logger config.
func (c *Config) buildEncoderConfig() zapcore.EncoderConfig {
	encoderConfig := zapcore.EncoderConfig{
		TimeKey:        "ts",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		MessageKey:     "msg",
		StacktraceKey:  "stack",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.SecondsDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}

	if c.Development {
		encoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	}

	return encoderConfig
}
