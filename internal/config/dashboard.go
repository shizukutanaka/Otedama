package config

import (
	"fmt"
	"time"
	"github.com/spf13/viper"
)

// DashboardConfig はダッシュボード設定
type DashboardConfig struct {
	Enabled       bool   `mapstructure:"enabled"`
	ListenAddr    string `mapstructure:"listen_addr"`
	EnableAuth    bool   `mapstructure:"enable_auth"`
	Username      string `mapstructure:"username"`
	Password      string `mapstructure:"password"`
	EnableTLS     bool   `mapstructure:"enable_tls"`
	CertFile      string `mapstructure:"cert_file"`
	KeyFile       string `mapstructure:"key_file"`
	RefreshRate   time.Duration `mapstructure:"refresh_rate"`
}

// setDashboardDefaults sets default values for dashboard configuration
func setDashboardDefaults() {
	viper.SetDefault("dashboard.enabled", true)
	viper.SetDefault("dashboard.listen_addr", ":8888")
	viper.SetDefault("dashboard.enable_auth", false)
	viper.SetDefault("dashboard.username", "admin")
	viper.SetDefault("dashboard.password", "")
	viper.SetDefault("dashboard.enable_tls", false)
	viper.SetDefault("dashboard.cert_file", "")
	viper.SetDefault("dashboard.key_file", "")
	viper.SetDefault("dashboard.refresh_rate", "1s")
}

// validateDashboard validates dashboard configuration
func validateDashboard(cfg *DashboardConfig) error {
	if cfg.Enabled && cfg.ListenAddr == "" {
		return fmt.Errorf("dashboard.listen_addr is required when dashboard is enabled")
	}
	
	if cfg.EnableAuth && (cfg.Username == "" || cfg.Password == "") {
		return fmt.Errorf("username and password are required when dashboard auth is enabled")
	}
	
	if cfg.EnableTLS && (cfg.CertFile == "" || cfg.KeyFile == "") {
		return fmt.Errorf("cert_file and key_file are required when dashboard TLS is enabled")
	}
	
	if cfg.RefreshRate < time.Second {
		return fmt.Errorf("dashboard refresh_rate must be at least 1 second")
	}
	
	return nil
}

// GetDashboardAddress returns the dashboard listen address
func (c *Config) GetDashboardAddress() string {
	if !c.Dashboard.Enabled {
		return ""
	}
	if c.Dashboard.ListenAddr == "" {
		return ":8888"
	}
	return c.Dashboard.ListenAddr
}

// IsDashboardEnabled returns whether the dashboard is enabled
func (c *Config) IsDashboardEnabled() bool {
	return c.Dashboard.Enabled
}