package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestLoadConfig tests configuration loading
func TestLoadConfig(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name         string
		configContent string
		validate     func(t *testing.T, cfg *Config)
		wantErr      bool
	}{
		{
			name: "valid config",
			configContent: `
mode: pool
log_level: debug

network:
  listen_addr: ":8333"
  max_peers: 50
  dial_timeout: 30s
  enable_p2p: true
  bootstrap_peers:
    - "peer1.example.com:8333"
    - "peer2.example.com:8333"

mining:
  algorithm: sha256d
  hardware_type: auto
  auto_detect: true
  threads: 4
  intensity: 100
  work_size: 256
  max_temperature: 85
  power_limit: 200
  auto_tuning: true
  initial_difficulty: 1000
  pools:
    - url: "stratum+tcp://pool1.example.com:3333"
      user: "user1"
      pass: "x"
      priority: 1
    - url: "stratum+tcp://pool2.example.com:3333"
      user: "user2"
      pass: "x"
      priority: 2

api:
  enabled: true
  listen_addr: ":8080"
  enable_tls: false
  rate_limit: 100

monitoring:
  metrics_interval: 10s
  enable_profiler: true
  enable_tracing: true
  prometheus_addr: ":9090"

storage:
  data_dir: "/var/otedama/data"
  cache_size: 1024
  compress_data: true
  backup_interval: 24h

security:
  enable_ddos_protection: true
  max_connections_per_ip: 10
  request_rate_limit: 100
  enable_tls: true
  cert_file: "/etc/otedama/cert.pem"
  key_file: "/etc/otedama/key.pem"

p2p_pool:
  enabled: true
  listen_addr: ":30303"
  max_peers: 100
  share_difficulty: 1000.0
  block_time: 10m
  payout_threshold: 0.01
  fee_percentage: 1.0

stratum:
  enabled: true
  listen_addr: ":3333"
  max_workers: 1000
  difficulty: 1000
  var_diff_enabled: true
  var_diff_min: 100
  var_diff_max: 100000
  share_timeout: 5m

performance:
  enable_cpu_affinity: true
  cpu_affinity_mask: [0, 1, 2, 3]
  enable_huge_pages: false
  huge_page_size: 2048
  memory_limit: 8192
  enable_numa_optimization: true
  numa_node: 0

zkp:
  enabled: true
  proof_expiry: 24h
  max_proof_size: 1048576
  security_level: 128
  require_age_proof: true
  min_age_requirement: 18
  require_identity_proof: false
  require_location_proof: true
  allowed_countries: ["US", "CA", "GB"]
  blocked_countries: ["CN", "RU"]
  require_hashpower_proof: true
  min_hashpower_requirement: 1000.0
  require_sanctions_proof: true

privacy:
  anonymous_mining: true
  enable_tor: false
  tor_proxy: "127.0.0.1:9050"
  enable_coin_mixing: false
  mixing_rounds: 3
`,
			validate: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "pool", cfg.Mode)
				assert.Equal(t, "debug", cfg.LogLevel)
				
				// Network config
				assert.Equal(t, ":8333", cfg.Network.ListenAddr)
				assert.Equal(t, 50, cfg.Network.MaxPeers)
				assert.Equal(t, 30*time.Second, cfg.Network.DialTimeout)
				assert.True(t, cfg.Network.EnableP2P)
				assert.Len(t, cfg.Network.BootstrapPeers, 2)
				
				// Mining config
				assert.Equal(t, "sha256d", cfg.Mining.Algorithm)
				assert.Equal(t, "auto", cfg.Mining.HardwareType)
				assert.True(t, cfg.Mining.AutoDetect)
				assert.Equal(t, 4, cfg.Mining.Threads)
				assert.Equal(t, 100, cfg.Mining.Intensity)
				assert.Equal(t, 256, cfg.Mining.WorkSize)
				assert.Equal(t, 85, cfg.Mining.MaxTemperature)
				assert.Equal(t, 200, cfg.Mining.PowerLimit)
				assert.True(t, cfg.Mining.AutoTuning)
				assert.Equal(t, uint32(1000), cfg.Mining.InitialDiff)
				assert.Len(t, cfg.Mining.Pools, 2)
				
				// API config
				assert.True(t, cfg.API.Enabled)
				assert.Equal(t, ":8080", cfg.API.ListenAddr)
				assert.False(t, cfg.API.EnableTLS)
				assert.Equal(t, 100, cfg.API.RateLimit)
				
				// ZKP config
				assert.True(t, cfg.ZKP.Enabled)
				assert.Equal(t, 24*time.Hour, cfg.ZKP.ProofExpiry)
				assert.Equal(t, 1048576, cfg.ZKP.MaxProofSize)
				assert.Equal(t, 128, cfg.ZKP.SecurityLevel)
				assert.True(t, cfg.ZKP.RequireAgeProof)
				assert.Equal(t, 18, cfg.ZKP.MinAgeRequirement)
				assert.True(t, cfg.ZKP.RequireLocationProof)
				assert.Equal(t, []string{"US", "CA", "GB"}, cfg.ZKP.AllowedCountries)
				assert.Equal(t, []string{"CN", "RU"}, cfg.ZKP.BlockedCountries)
				assert.True(t, cfg.ZKP.RequireHashpowerProof)
				assert.Equal(t, 1000.0, cfg.ZKP.MinHashpowerRequirement)
				
				// Privacy config
				assert.True(t, cfg.Privacy.AnonymousMining)
				assert.False(t, cfg.Privacy.EnableTor)
				assert.Equal(t, "127.0.0.1:9050", cfg.Privacy.TorProxy)
			},
			wantErr: false,
		},
		{
			name: "minimal config",
			configContent: `
mode: solo
log_level: info
`,
			validate: func(t *testing.T, cfg *Config) {
				assert.Equal(t, "solo", cfg.Mode)
				assert.Equal(t, "info", cfg.LogLevel)
				
				// Check defaults are applied
				assert.NotEmpty(t, cfg.Network.ListenAddr)
				assert.Greater(t, cfg.Network.MaxPeers, 0)
			},
			wantErr: false,
		},
		{
			name: "legacy mining config",
			configContent: `
mode: pool
log_level: info

mining:
  algorithm: sha256
  enable_cpu: true
  enable_gpu: false
  enable_asic: false
  threads: 8
`,
			validate: func(t *testing.T, cfg *Config) {
				// Legacy fields should be converted to hardware_type
				assert.Equal(t, "cpu", cfg.Mining.HardwareType)
				assert.Equal(t, 8, cfg.Mining.Threads)
			},
			wantErr: false,
		},
		{
			name:          "empty config",
			configContent: "",
			validate: func(t *testing.T, cfg *Config) {
				// Should have defaults
				assert.NotEmpty(t, cfg.Mode)
				assert.NotEmpty(t, cfg.LogLevel)
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			// Create temporary config file
			tempDir := t.TempDir()
			configPath := filepath.Join(tempDir, "config.yaml")
			
			err := os.WriteFile(configPath, []byte(tt.configContent), 0644)
			require.NoError(t, err)
			
			// Load config
			cfg, err := Load(configPath)
			
			if tt.wantErr {
				assert.Error(t, err)
				assert.Nil(t, cfg)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, cfg)
				if tt.validate != nil {
					tt.validate(t, cfg)
				}
			}
		})
	}
}

// TestLoadDefaults tests default configuration values
func TestLoadDefaults(t *testing.T) {
	t.Parallel()
	
	// Test that setDefaults doesn't panic
	setDefaults()
	
	// Create empty config file
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	
	err := os.WriteFile(configPath, []byte(""), 0644)
	require.NoError(t, err)
	
	// Load config (defaults should be applied)
	cfg, err := Load(configPath)
	require.NoError(t, err)
	
	// Verify defaults
	assert.Equal(t, "pool", cfg.Mode)
	assert.Equal(t, "info", cfg.LogLevel)
	
	// Network defaults
	assert.Equal(t, ":8333", cfg.Network.ListenAddr)
	assert.Equal(t, 50, cfg.Network.MaxPeers)
	assert.Equal(t, 30*time.Second, cfg.Network.DialTimeout)
	
	// Mining defaults
	assert.Equal(t, "sha256d", cfg.Mining.Algorithm)
	assert.Equal(t, "auto", cfg.Mining.HardwareType)
	assert.True(t, cfg.Mining.AutoDetect)
	assert.Greater(t, cfg.Mining.Threads, 0) // Should be set to runtime.NumCPU()
	
	// API defaults
	assert.True(t, cfg.API.Enabled)
	assert.Equal(t, ":8080", cfg.API.ListenAddr)
	
	// Storage defaults
	assert.NotEmpty(t, cfg.Storage.DataDir)
	assert.Greater(t, cfg.Storage.CacheSize, 0)
	
	// Security defaults
	assert.True(t, cfg.Security.EnableDDoSProtection)
	assert.Greater(t, cfg.Security.MaxConnectionsPerIP, 0)
	
	// ZKP defaults
	assert.False(t, cfg.ZKP.Enabled)
	assert.Equal(t, 24*time.Hour, cfg.ZKP.ProofExpiry)
	assert.Equal(t, 128, cfg.ZKP.SecurityLevel)
}

// TestValidateConfig tests configuration validation
func TestValidateConfig(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name    string
		config  *Config
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid config",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					ListenAddr: ":8333",
					MaxPeers:   50,
				},
				Mining: MiningConfig{
					Algorithm:    "sha256d",
					HardwareType: "cpu",
					Threads:      4,
				},
				API: APIConfig{
					Enabled:    true,
					ListenAddr: ":8080",
				},
				P2PPool: P2PPoolConfig{
					ShareDifficulty: 1000.0,
					FeePercentage:   1.0,
				},
				Stratum: StratumConfig{
					MinDiff:    100.0,
					MaxDiff:    10000.0,
					TargetTime: 10,
				},
				ZKP: ZKPConfig{
					MinAgeRequirement:      18,
					MinHashpowerRequirement: 1000.0,
					MinReputationScore:     0.5,
				},
			},
			wantErr: false,
		},
		{
			name: "invalid mode",
			config: &Config{
				Mode:     "invalid",
				LogLevel: "info",
			},
			wantErr: true,
			errMsg:  "invalid mode",
		},
		{
			name: "zero max peers",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					MaxPeers: 0,
				},
			},
			wantErr: true,
			errMsg:  "max_peers must be greater than 0",
		},
		{
			name: "negative threads",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					MaxPeers: 50,
				},
				Mining: MiningConfig{
					Algorithm: "sha256d",
					Threads:   -1,
				},
			},
			wantErr: true,
			errMsg:  "threads must be greater than 0",
		},
		{
			name: "invalid stratum difficulty range",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					MaxPeers: 50,
				},
				Mining: MiningConfig{
					Threads: 4,
				},
				P2PPool: P2PPoolConfig{
					ShareDifficulty: 1000.0,
					FeePercentage:   1.0,
				},
				Stratum: StratumConfig{
					MinDiff:    1000.0,
					MaxDiff:    100.0, // Max less than min
					TargetTime: 10,
				},
			},
			wantErr: true,
			errMsg:  "min_diff must be less than max_diff",
		},
		{
			name: "negative share difficulty",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					MaxPeers: 50,
				},
				Mining: MiningConfig{
					Threads: 4,
				},
				P2PPool: P2PPoolConfig{
					ShareDifficulty: -1.0,
					FeePercentage:   1.0,
				},
			},
			wantErr: true,
			errMsg:  "share_difficulty must be greater than 0",
		},
		{
			name: "invalid fee percentage",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					MaxPeers: 50,
				},
				Mining: MiningConfig{
					Threads: 4,
				},
				P2PPool: P2PPoolConfig{
					ShareDifficulty: 1000.0,
					FeePercentage:   -1.0,
				},
			},
			wantErr: true,
			errMsg:  "fee_percentage must be between 0 and 100",
		},
		{
			name: "invalid zkp security level",
			config: &Config{
				Mode:     "pool",
				LogLevel: "info",
				Network: NetworkConfig{
					MaxPeers: 50,
				},
				Mining: MiningConfig{
					Threads: 4,
				},
				P2PPool: P2PPoolConfig{
					ShareDifficulty: 1000.0,
					FeePercentage:   1.0,
				},
				ZKP: ZKPConfig{
					Enabled:       true,
					SecurityLevel: 64, // Too low
				},
			},
			wantErr: true,
			errMsg:  "security_level must be 128 or 256",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			err := validate(tt.config)
			
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// TestSaveConfig tests configuration saving
func TestSaveConfig(t *testing.T) {
	t.Parallel()
	
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	
	cfg := &Config{
		Mode:     "test",
		LogLevel: "debug",
		Network: NetworkConfig{
			ListenAddr:     ":9999",
			MaxPeers:       100,
			DialTimeout:    60 * time.Second,
			EnableP2P:      true,
			BootstrapPeers: []string{"peer1:8333", "peer2:8333"},
		},
		Mining: MiningConfig{
			Algorithm:      "ethash",
			HardwareType:   "gpu",
			Threads:        8,
			InitialDiff:    2000,
			MaxTemperature: 90,
			PowerLimit:     250,
			AutoTuning:     true,
			Pools: []PoolConfig{
				{
					URL:      "stratum+tcp://pool.example.com:3333",
					User:     "testuser",
					Pass:     "x",
					Priority: 1,
				},
			},
		},
		ZKP: ZKPConfig{
			Enabled:                true,
			ProofExpiry:            48 * time.Hour,
			RequireAgeProof:        true,
			MinAgeRequirement:      21,
			RequireHashpowerProof:  true,
			MinHashpowerRequirement: 5000.0,
		},
	}
	
	// Save config
	err := Save(cfg, configPath)
	require.NoError(t, err)
	
	// Load saved config and verify
	loaded, err := Load(configPath)
	require.NoError(t, err)
	
	assert.Equal(t, cfg.Mode, loaded.Mode)
	assert.Equal(t, cfg.LogLevel, loaded.LogLevel)
	assert.Equal(t, cfg.Network.ListenAddr, loaded.Network.ListenAddr)
	assert.Equal(t, cfg.Network.MaxPeers, loaded.Network.MaxPeers)
	assert.Equal(t, cfg.Mining.Algorithm, loaded.Mining.Algorithm)
	assert.Equal(t, cfg.Mining.HardwareType, loaded.Mining.HardwareType)
	assert.Equal(t, cfg.Mining.Threads, loaded.Mining.Threads)
	assert.Len(t, loaded.Mining.Pools, 1)
	assert.Equal(t, cfg.Mining.Pools[0].URL, loaded.Mining.Pools[0].URL)
	assert.Equal(t, cfg.ZKP.Enabled, loaded.ZKP.Enabled)
	assert.Equal(t, cfg.ZKP.MinAgeRequirement, loaded.ZKP.MinAgeRequirement)
}

// TestMiningConfig tests mining configuration
func TestMiningConfig(t *testing.T) {
	t.Parallel()
	
	cfg := MiningConfig{
		Algorithm:      "sha256d",
		HardwareType:   "gpu",
		AutoDetect:     true,
		Threads:        8,
		Intensity:      100,
		WorkSize:       256,
		MaxTemperature: 85,
		PowerLimit:     200,
		AutoTuning:     true,
		TargetHashRate: 1000000000, // 1 GH/s
		GPUDevices:     []int{0, 1},
		EnableCUDA:     true,
		EnableOpenCL:   true,
		InitialDiff:    1000,
	}
	
	assert.Equal(t, "sha256d", cfg.Algorithm)
	assert.Equal(t, "gpu", cfg.HardwareType)
	assert.True(t, cfg.AutoDetect)
	assert.True(t, cfg.AutoTuning)
	assert.Equal(t, 85, cfg.MaxTemperature)
	assert.Equal(t, uint64(1000000000), cfg.TargetHashRate)
	assert.Len(t, cfg.GPUDevices, 2)
	assert.True(t, cfg.EnableCUDA)
	assert.True(t, cfg.EnableOpenCL)
}

// TestZKPConfig tests ZKP configuration
func TestZKPConfig(t *testing.T) {
	t.Parallel()
	
	cfg := ZKPConfig{
		Enabled:                true,
		ProofExpiry:            24 * time.Hour,
		MaxProofSize:           1024 * 1024, // 1 MB
		SecurityLevel:          256,
		RequireAgeProof:        true,
		MinAgeRequirement:      18,
		RequireIdentityProof:   true,
		RequireLocationProof:   true,
		AllowedCountries:       []string{"US", "CA", "GB", "AU"},
		BlockedCountries:       []string{"CN", "RU", "KP"},
		RequireHashpowerProof:  true,
		MinHashpowerRequirement: 1000.0,
		RequireSanctionsProof:  true,
	}
	
	assert.True(t, cfg.Enabled)
	assert.Equal(t, 24*time.Hour, cfg.ProofExpiry)
	assert.Equal(t, 1024*1024, cfg.MaxProofSize)
	assert.Equal(t, 256, cfg.SecurityLevel)
	assert.True(t, cfg.RequireAgeProof)
	assert.Equal(t, 18, cfg.MinAgeRequirement)
	assert.Len(t, cfg.AllowedCountries, 4)
	assert.Len(t, cfg.BlockedCountries, 3)
}

// TestEnvironmentOverrides tests environment variable overrides
func TestEnvironmentOverrides(t *testing.T) {
	t.Parallel()
	
	// Set environment variables
	t.Setenv("OTEDAMA_MODE", "test")
	t.Setenv("OTEDAMA_LOG_LEVEL", "debug")
	t.Setenv("OTEDAMA_NETWORK_LISTEN_ADDR", ":9999")
	t.Setenv("OTEDAMA_MINING_THREADS", "16")
	t.Setenv("OTEDAMA_ZKP_ENABLED", "true")
	t.Setenv("OTEDAMA_ZKP_MIN_AGE_REQUIREMENT", "21")
	
	// Create minimal config file
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	
	configContent := `
mode: pool
log_level: info
`
	
	err := os.WriteFile(configPath, []byte(configContent), 0644)
	require.NoError(t, err)
	
	// Load config - environment variables should override file values
	cfg, err := Load(configPath)
	require.NoError(t, err)
	
	assert.Equal(t, "test", cfg.Mode)
	assert.Equal(t, "debug", cfg.LogLevel)
	assert.Equal(t, ":9999", cfg.Network.ListenAddr)
	assert.Equal(t, 16, cfg.Mining.Threads)
	assert.True(t, cfg.ZKP.Enabled)
	assert.Equal(t, 21, cfg.ZKP.MinAgeRequirement)
}

// TestConfigMigration tests configuration migration from old formats
func TestConfigMigration(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name      string
		oldConfig string
		validate  func(t *testing.T, cfg *Config)
	}{
		{
			name: "migrate legacy mining flags",
			oldConfig: `
mode: pool
mining:
  algorithm: sha256
  enable_cpu: true
  enable_gpu: true
  enable_asic: false
  threads: 8
`,
			validate: func(t *testing.T, cfg *Config) {
				// Should convert to hardware_type: auto (since both CPU and GPU are enabled)
				assert.Equal(t, "auto", cfg.Mining.HardwareType)
				assert.Equal(t, 8, cfg.Mining.Threads)
			},
		},
		{
			name: "migrate old pool format",
			oldConfig: `
mode: pool
mining:
  pool_url: "stratum+tcp://pool.example.com:3333"
  pool_user: "user123"
  pool_pass: "x"
`,
			validate: func(t *testing.T, cfg *Config) {
				// Should convert to pools array
				assert.Len(t, cfg.Mining.Pools, 1)
				assert.Equal(t, "stratum+tcp://pool.example.com:3333", cfg.Mining.Pools[0].URL)
				assert.Equal(t, "user123", cfg.Mining.Pools[0].User)
				assert.Equal(t, "x", cfg.Mining.Pools[0].Pass)
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			tempDir := t.TempDir()
			configPath := filepath.Join(tempDir, "config.yaml")
			
			err := os.WriteFile(configPath, []byte(tt.oldConfig), 0644)
			require.NoError(t, err)
			
			cfg, err := Load(configPath)
			require.NoError(t, err)
			
			tt.validate(t, cfg)
		})
	}
}

// TestConfigReload tests configuration reloading
func TestConfigReload(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	
	// Initial config
	initialConfig := `
mode: pool
log_level: info
mining:
  threads: 4
`
	
	err := os.WriteFile(configPath, []byte(initialConfig), 0644)
	require.NoError(t, err)
	
	cfg, err := Load(configPath)
	require.NoError(t, err)
	
	assert.Equal(t, "pool", cfg.Mode)
	assert.Equal(t, 4, cfg.Mining.Threads)
	
	// Update config file
	updatedConfig := `
mode: solo
log_level: debug
mining:
  threads: 8
`
	
	err = os.WriteFile(configPath, []byte(updatedConfig), 0644)
	require.NoError(t, err)
	
	// Reload config
	cfg, err = Load(configPath)
	require.NoError(t, err)
	
	assert.Equal(t, "solo", cfg.Mode)
	assert.Equal(t, "debug", cfg.LogLevel)
	assert.Equal(t, 8, cfg.Mining.Threads)
}

// TestConfigConcurrency tests concurrent config access
func TestConfigConcurrency(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	
	configContent := `
mode: pool
log_level: info
`
	
	err := os.WriteFile(configPath, []byte(configContent), 0644)
	require.NoError(t, err)
	
	// Test concurrent loads
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cfg, err := Load(configPath)
			assert.NoError(t, err)
			assert.NotNil(t, cfg)
		}()
	}
	wg.Wait()
}

// TestConfigEdgeCases tests edge cases
func TestConfigEdgeCases(t *testing.T) {
	t.Parallel()
	
	t.Run("non-existent config file", func(t *testing.T) {
		cfg, err := Load("/non/existent/path/config.yaml")
		assert.Error(t, err)
		assert.Nil(t, cfg)
	})
	
	t.Run("invalid yaml syntax", func(t *testing.T) {
		tempDir := t.TempDir()
		configPath := filepath.Join(tempDir, "config.yaml")
		
		invalidYaml := `
mode: pool
  invalid indentation
`
		err := os.WriteFile(configPath, []byte(invalidYaml), 0644)
		require.NoError(t, err)
		
		cfg, err := Load(configPath)
		assert.Error(t, err)
		assert.Nil(t, cfg)
	})
	
	t.Run("permission denied", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("Running as root, skipping permission test")
		}
		
		tempDir := t.TempDir()
		configPath := filepath.Join(tempDir, "config.yaml")
		
		err := os.WriteFile(configPath, []byte("mode: pool"), 0644)
		require.NoError(t, err)
		
		// Remove read permission
		err = os.Chmod(configPath, 0000)
		require.NoError(t, err)
		
		cfg, err := Load(configPath)
		assert.Error(t, err)
		assert.Nil(t, cfg)
		
		// Restore permission for cleanup
		_ = os.Chmod(configPath, 0644)
	})
}

// Benchmark tests
func BenchmarkLoadConfig(b *testing.B) {
	tempDir := b.TempDir()
	configPath := filepath.Join(tempDir, "config.yaml")
	
	configContent := `
mode: pool
log_level: info
network:
  listen_addr: ":8333"
  max_peers: 50
mining:
  algorithm: sha256d
  threads: 4
`
	
	err := os.WriteFile(configPath, []byte(configContent), 0644)
	require.NoError(b, err)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = Load(configPath)
	}
}

func BenchmarkValidateConfig(b *testing.B) {
	cfg := &Config{
		Mode:     "pool",
		LogLevel: "info",
		Network: NetworkConfig{
			ListenAddr: ":8333",
			MaxPeers:   50,
		},
		Mining: MiningConfig{
			Algorithm: "sha256d",
			Threads:   4,
		},
		P2PPool: P2PPoolConfig{
			ShareDifficulty: 1000.0,
			FeePercentage:   1.0,
		},
		Stratum: StratumConfig{
			MinDiff:    100.0,
			MaxDiff:    10000.0,
			TargetTime: 10,
		},
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = validate(cfg)
	}
}

func BenchmarkSaveConfig(b *testing.B) {
	tempDir := b.TempDir()
	
	cfg := &Config{
		Mode:     "pool",
		LogLevel: "info",
		Network: NetworkConfig{
			ListenAddr: ":8333",
			MaxPeers:   50,
		},
		Mining: MiningConfig{
			Algorithm: "sha256d",
			Threads:   4,
		},
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		configPath := filepath.Join(tempDir, fmt.Sprintf("config_%d.yaml", i))
		_ = Save(cfg, configPath)
	}
}