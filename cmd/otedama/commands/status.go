package commands

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/spf13/cobra"
)

// statusCmd represents the status command
var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show mining status",
	Long:  `Display current mining status including hash rate, shares, and system information.`,
	RunE:  runStatus,
}

// MiningStatus represents the mining status response
type MiningStatus struct {
	Status      string                 `json:"status"`
	Algorithm   string                 `json:"algorithm"`
	Uptime      float64                `json:"uptime"`
	Mining      MiningInfo             `json:"mining"`
	Network     NetworkInfo            `json:"network"`
	System      SystemInfo             `json:"system"`
	Pools       []PoolInfo             `json:"pools,omitempty"`
	Devices     []DeviceInfo           `json:"devices,omitempty"`
	LastUpdated time.Time              `json:"last_updated"`
}

type MiningInfo struct {
	HashRate        float64 `json:"hashrate"`
	SharesAccepted  uint64  `json:"shares_accepted"`
	SharesRejected  uint64  `json:"shares_rejected"`
	SharesStale     uint64  `json:"shares_stale"`
	BlocksFound     uint64  `json:"blocks_found"`
	Efficiency      float64 `json:"efficiency"`
	PowerUsage      float64 `json:"power_usage"`
}

type NetworkInfo struct {
	P2PEnabled      bool   `json:"p2p_enabled"`
	PeersConnected  int    `json:"peers_connected"`
	StratumEnabled  bool   `json:"stratum_enabled"`
	WorkersOnline   int    `json:"workers_online"`
}

type SystemInfo struct {
	CPUUsage        float64 `json:"cpu_usage"`
	MemoryUsage     uint64  `json:"memory_usage"`
	Temperature     float64 `json:"temperature"`
	Version         string  `json:"version"`
}

type PoolInfo struct {
	URL             string  `json:"url"`
	Status          string  `json:"status"`
	Difficulty      float64 `json:"difficulty"`
	LastShare       string  `json:"last_share"`
}

type DeviceInfo struct {
	ID              string  `json:"id"`
	Type            string  `json:"type"`
	Name            string  `json:"name"`
	HashRate        float64 `json:"hashrate"`
	Temperature     float64 `json:"temperature"`
	PowerUsage      float64 `json:"power_usage"`
	Status          string  `json:"status"`
}

func init() {
	rootCmd.AddCommand(statusCmd)
	
	statusCmd.Flags().String("api", "http://localhost:8080", "API endpoint")
	statusCmd.Flags().String("format", "text", "Output format (text, json, table)")
	statusCmd.Flags().Bool("watch", false, "Watch status continuously")
	statusCmd.Flags().Duration("interval", 5*time.Second, "Watch interval")
}

func runStatus(cmd *cobra.Command, args []string) error {
	apiEndpoint, _ := cmd.Flags().GetString("api")
	format, _ := cmd.Flags().GetString("format")
	watch, _ := cmd.Flags().GetBool("watch")
	interval, _ := cmd.Flags().GetDuration("interval")
	
	if watch {
		// Clear screen
		fmt.Print("\033[H\033[2J")
		
		for {
			// Move cursor to top
			fmt.Print("\033[H")
			
			if err := displayStatus(apiEndpoint, format); err != nil {
				fmt.Printf("Error: %v\n", err)
			}
			
			time.Sleep(interval)
		}
	} else {
		return displayStatus(apiEndpoint, format)
	}
}

func displayStatus(apiEndpoint, format string) error {
	// Fetch status from API
	status, err := fetchStatus(apiEndpoint)
	if err != nil {
		// If API is not available, try to get local status
		status = getLocalStatus()
	}
	
	switch format {
	case "json":
		return displayJSON(status)
	case "table":
		return displayTable(status)
	default:
		return displayText(status)
	}
}

func fetchStatus(apiEndpoint string) (*MiningStatus, error) {
	client := &http.Client{
		Timeout: 5 * time.Second,
	}
	
	resp, err := client.Get(apiEndpoint + "/api/v1/status")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d", resp.StatusCode)
	}
	
	var status MiningStatus
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return nil, err
	}
	
	return &status, nil
}

func getLocalStatus() *MiningStatus {
	// Return a mock status when API is not available
	return &MiningStatus{
		Status:    "offline",
		Algorithm: "unknown",
		Uptime:    0,
		Mining: MiningInfo{
			HashRate:       0,
			SharesAccepted: 0,
			SharesRejected: 0,
			SharesStale:    0,
			BlocksFound:    0,
			Efficiency:     0,
			PowerUsage:     0,
		},
		Network: NetworkInfo{
			P2PEnabled:     false,
			PeersConnected: 0,
			StratumEnabled: false,
			WorkersOnline:  0,
		},
		System: SystemInfo{
			CPUUsage:    0,
			MemoryUsage: 0,
			Temperature: 0,
			Version:     "unknown",
		},
		LastUpdated: time.Now(),
	}
}

func displayText(status *MiningStatus) error {
	fmt.Println("=== Otedama Mining Status ===")
	fmt.Printf("Status:     %s\n", getStatusColor(status.Status))
	fmt.Printf("Algorithm:  %s\n", status.Algorithm)
	fmt.Printf("Uptime:     %s\n", formatDuration(status.Uptime))
	fmt.Println()
	
	fmt.Println("Mining Performance:")
	fmt.Printf("  Hash Rate:       %s\n", formatHashRate(status.Mining.HashRate))
	fmt.Printf("  Shares Accepted: %d\n", status.Mining.SharesAccepted)
	fmt.Printf("  Shares Rejected: %d (%.2f%%)\n", 
		status.Mining.SharesRejected, 
		getRejectRate(status.Mining))
	fmt.Printf("  Blocks Found:    %d\n", status.Mining.BlocksFound)
	fmt.Printf("  Power Usage:     %.2f W\n", status.Mining.PowerUsage)
	fmt.Printf("  Efficiency:      %.2f H/W\n", status.Mining.Efficiency)
	fmt.Println()
	
	fmt.Println("Network:")
	fmt.Printf("  P2P:      %s (%d peers)\n", 
		getEnabledStatus(status.Network.P2PEnabled),
		status.Network.PeersConnected)
	fmt.Printf("  Stratum:  %s (%d workers)\n",
		getEnabledStatus(status.Network.StratumEnabled),
		status.Network.WorkersOnline)
	fmt.Println()
	
	if len(status.Devices) > 0 {
		fmt.Println("Devices:")
		for _, device := range status.Devices {
			fmt.Printf("  [%s] %s: %s @ %.1f°C, %.2f W\n",
				device.Type,
				device.Name,
				formatHashRate(device.HashRate),
				device.Temperature,
				device.PowerUsage)
		}
		fmt.Println()
	}
	
	if len(status.Pools) > 0 {
		fmt.Println("Pools:")
		for _, pool := range status.Pools {
			fmt.Printf("  %s: %s (diff: %.0f)\n",
				pool.URL,
				pool.Status,
				pool.Difficulty)
		}
		fmt.Println()
	}
	
	fmt.Printf("Last Updated: %s\n", status.LastUpdated.Format("15:04:05"))
	
	return nil
}

func displayJSON(status *MiningStatus) error {
	encoder := json.NewEncoder(fmt.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(status)
}

func displayTable(status *MiningStatus) error {
	// Simple table format
	fmt.Println("┌─────────────────────┬────────────────────┐")
	fmt.Printf("│ %-19s │ %-18s │\n", "Metric", "Value")
	fmt.Println("├─────────────────────┼────────────────────┤")
	fmt.Printf("│ %-19s │ %-18s │\n", "Status", status.Status)
	fmt.Printf("│ %-19s │ %-18s │\n", "Algorithm", status.Algorithm)
	fmt.Printf("│ %-19s │ %-18s │\n", "Hash Rate", formatHashRate(status.Mining.HashRate))
	fmt.Printf("│ %-19s │ %-18d │\n", "Shares Accepted", status.Mining.SharesAccepted)
	fmt.Printf("│ %-19s │ %-18d │\n", "Shares Rejected", status.Mining.SharesRejected)
	fmt.Printf("│ %-19s │ %-18d │\n", "Blocks Found", status.Mining.BlocksFound)
	fmt.Printf("│ %-19s │ %-18.2f │\n", "Power (W)", status.Mining.PowerUsage)
	fmt.Printf("│ %-19s │ %-18.2f │\n", "Efficiency (H/W)", status.Mining.Efficiency)
	fmt.Printf("│ %-19s │ %-18d │\n", "Peers Connected", status.Network.PeersConnected)
	fmt.Printf("│ %-19s │ %-18s │\n", "Uptime", formatDuration(status.Uptime))
	fmt.Println("└─────────────────────┴────────────────────┘")
	
	return nil
}

// Helper functions

func getStatusColor(status string) string {
	switch status {
	case "running", "online":
		return fmt.Sprintf("\033[32m%s\033[0m", status) // Green
	case "stopped", "offline":
		return fmt.Sprintf("\033[31m%s\033[0m", status) // Red
	default:
		return fmt.Sprintf("\033[33m%s\033[0m", status) // Yellow
	}
}

func getEnabledStatus(enabled bool) string {
	if enabled {
		return "\033[32mEnabled\033[0m"
	}
	return "\033[31mDisabled\033[0m"
}

func formatHashRate(hashRate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s"}
	unitIndex := 0
	
	for hashRate >= 1000 && unitIndex < len(units)-1 {
		hashRate /= 1000
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f %s", hashRate, units[unitIndex])
}

func formatDuration(seconds float64) string {
	duration := time.Duration(seconds) * time.Second
	days := int(duration.Hours() / 24)
	hours := int(duration.Hours()) % 24
	minutes := int(duration.Minutes()) % 60
	
	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
	} else if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}

func getRejectRate(mining MiningInfo) float64 {
	total := mining.SharesAccepted + mining.SharesRejected
	if total == 0 {
		return 0
	}
	return float64(mining.SharesRejected) * 100 / float64(total)
}
