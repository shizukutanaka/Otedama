package commands

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// initCmd represents the init command
var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize Otedama configuration",
	Long: `Initialize Otedama configuration files including:
- config.yaml (main configuration)
- wallet.key (ZKP wallet key)  
- peers.json (P2P bootstrap nodes)`,
	RunE: runInit,
}

func init() {
	rootCmd.AddCommand(initCmd)
	
	initCmd.Flags().String("config-dir", ".", "Configuration directory")
	initCmd.Flags().Bool("force", false, "Overwrite existing configuration")
}

func runInit(cmd *cobra.Command, args []string) error {
	configDir, _ := cmd.Flags().GetString("config-dir")
	force, _ := cmd.Flags().GetBool("force")
	
	// Create config directory if it doesn't exist
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	
	// Generate config.yaml
	configPath := filepath.Join(configDir, "config.yaml")
	if err := generateConfig(configPath, force); err != nil {
		return fmt.Errorf("failed to generate config.yaml: %w", err)
	}
	
	// Generate wallet.key
	walletPath := filepath.Join(configDir, "wallet.key")
	if err := generateWalletKey(walletPath, force); err != nil {
		return fmt.Errorf("failed to generate wallet.key: %w", err)
	}
	
	// Generate peers.json
	peersPath := filepath.Join(configDir, "peers.json")
	if err := generatePeersFile(peersPath, force); err != nil {
		return fmt.Errorf("failed to generate peers.json: %w", err)
	}
	
	fmt.Printf("Otedama configuration initialized in %s\n", configDir)
	fmt.Println("Files created:")
	fmt.Printf("  - %s (main configuration)\n", configPath)
	fmt.Printf("  - %s (ZKP wallet key)\n", walletPath)
	fmt.Printf("  - %s (P2P bootstrap nodes)\n", peersPath)
	fmt.Println("\nNext steps:")
	fmt.Println("  1. Edit config.yaml to customize your settings")
	fmt.Println("  2. Run 'otedama start' to begin mining")
	
	return nil
}

func generateConfig(path string, force bool) error {
	if !force && fileExists(path) {
		return fmt.Errorf("config.yaml already exists, use --force to overwrite")
	}
	
	defaultConfig := map[string]interface{}{
		"mining": map[string]interface{}{
			"mode": "auto",
			"algorithms": []map[string]interface{}{
				{
					"name":      "ethash",
					"enabled":   true,
					"intensity": 80,
				},
				{
					"name":    "randomx",
					"enabled": true,
					"threads": 8,
				},
				{
					"name":     "kawpow",
					"enabled":  true,
					"gpu_only": true,
				},
			},
		},
		"hardware": map[string]interface{}{
			"cpu": map[string]interface{}{
				"threads":    0,
				"affinity":   true,
				"huge_pages": true,
			},
			"gpu": []map[string]interface{}{
				{
					"index":        0,
					"enabled":      true,
					"memory_clock": 2100,
					"core_clock":   1800,
					"power_limit":  220,
					"fan_speed":    "auto",
				},
			},
			"asic": map[string]interface{}{
				"enabled": false,
				"devices": []interface{}{},
			},
		},
		"p2p": map[string]interface{}{
			"enabled":   true,
			"mode":      "hybrid",
			"listen":    "0.0.0.0:3333",
			"max_peers": 100,
			"bootstrap_nodes": []string{
				"seed1.otedama.network:3333",
				"seed2.otedama.network:3333",
			},
		},
		"zkp": map[string]interface{}{
			"enabled":              true,
			"identity_proof":       true,
			"compliance_proof":     false,
			"reputation_threshold": 0.8,
		},
		"optimization": map[string]interface{}{
			"auto_tuning":      true,
			"profit_switching": true,
			"power_efficiency": "balanced",
		},
		"features": map[string]interface{}{
			"blockchain_integration":  true,
			"smart_payouts":          true,
			"renewable_energy":       false,
			"container_mode":         false,
			"hardware_monitoring":    true,
			"predictive_maintenance": true,
		},
		"logging": map[string]interface{}{
			"level":      "info",
			"file":       "otedama.log",
			"max_size":   100,
			"max_age":    7,
			"max_backup": 3,
		},
		"monitoring": map[string]interface{}{
			"enabled":          true,
			"metrics_interval": "10s",
			"dashboard_port":   8080,
			"api_port":         8081,
		},
	}
	
	data, err := yaml.Marshal(defaultConfig)
	if err != nil {
		return err
	}
	
	return os.WriteFile(path, data, 0644)
}

func generateWalletKey(path string, force bool) error {
	if !force && fileExists(path) {
		return fmt.Errorf("wallet.key already exists, use --force to overwrite")
	}
	
	// Generate a random 32-byte key for ZKP
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return fmt.Errorf("failed to generate random key: %w", err)
	}
	
	// Encode as hex
	hexKey := hex.EncodeToString(key)
	
	// Save with metadata
	data := fmt.Sprintf("# Otedama ZKP Wallet Key\n# Generated: %s\n# WARNING: Keep this file secure!\n\n%s\n",
		time.Now().Format(time.RFC3339), hexKey)
	
	return os.WriteFile(path, []byte(data), 0600) // Restricted permissions
}

func generatePeersFile(path string, force bool) error {
	if !force && fileExists(path) {
		return fmt.Errorf("peers.json already exists, use --force to overwrite")
	}
	
	peers := map[string]interface{}{
		"version": "1.0",
		"updated": time.Now().Format(time.RFC3339),
		"bootstrap_nodes": []map[string]interface{}{
			{
				"id":       "node1",
				"address":  "seed1.otedama.network:3333",
				"location": "US-East",
				"type":     "bootstrap",
			},
			{
				"id":       "node2",
				"address":  "seed2.otedama.network:3333",
				"location": "EU-West",
				"type":     "bootstrap",
			},
			{
				"id":       "node3",
				"address":  "seed3.otedama.network:3333",
				"location": "Asia-Pacific",
				"type":     "bootstrap",
			},
		},
		"fallback_nodes": []map[string]interface{}{
			{
				"id":      "fallback1",
				"address": "backup1.otedama.network:3333",
			},
			{
				"id":      "fallback2",
				"address": "backup2.otedama.network:3333",
			},
		},
	}
	
	data, err := json.MarshalIndent(peers, "", "  ")
	if err != nil {
		return err
	}
	
	return os.WriteFile(path, data, 0644)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return !os.IsNotExist(err)
}