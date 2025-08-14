package commands

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// statusCmd represents the status command
var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show mining status",
	Long:  `Display current mining status including hashrate, temperature, and earnings.`,
	RunE:  runStatus,
}

func init() {
	rootCmd.AddCommand(statusCmd)
	
	statusCmd.Flags().String("api-url", "http://localhost:8081", "API server URL")
	statusCmd.Flags().String("format", "table", "Output format (table, json, yaml)")
	statusCmd.Flags().Bool("watch", false, "Watch status (refresh every 5s)")
	statusCmd.Flags().Duration("interval", 5*time.Second, "Watch interval")
}

func runStatus(cmd *cobra.Command, args []string) error {
	apiURL, _ := cmd.Flags().GetString("api-url")
	format, _ := cmd.Flags().GetString("format")
	watch, _ := cmd.Flags().GetBool("watch")
	interval, _ := cmd.Flags().GetDuration("interval")
	
	// If watching, clear screen and loop
	if watch {
		for {
			// Clear screen (ANSI escape code)
			fmt.Print("\033[H\033[2J")
			
			if err := displayStatus(apiURL, format); err != nil {
				return err
			}
			
			time.Sleep(interval)
		}
	}
	
	return displayStatus(apiURL, format)
}

func displayStatus(apiURL, format string) error {
	// Fetch status from API
	status, err := fetchStatus(apiURL)
	if err != nil {
		return fmt.Errorf("failed to fetch status: %w", err)
	}
	
	switch format {
	case "json":
		return displayJSON(status)
	case "yaml":
		return displayYAML(status)
	default:
		return displayTable(status)
	}
}

func fetchStatus(apiURL string) (*MiningStatus, error) {
	resp, err := http.Get(apiURL + "/api/v1/status")
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

func displayTable(status *MiningStatus) error {
	fmt.Printf("Otedama Mining Status - %s\n\n", time.Now().Format("2006-01-02 15:04:05"))
    
    // Overview
    fmt.Println("Overview:")
    fmt.Printf("  Status           : %s %s\n", getStatusEmoji(status.Status), status.Status)
    fmt.Printf("  Uptime           : %s\n", humanize.Time(status.StartTime))
    fmt.Printf("  Total Hashrate   : %s\n", humanize.SI(status.TotalHashrate, "H/s"))
    fmt.Printf("  Shares Accepted  : %d (%.1f%%)\n", status.SharesAccepted, status.SharesAcceptedRate*100)
    fmt.Printf("  Shares Rejected  : %d (%.1f%%)\n", status.SharesRejected, status.SharesRejectedRate*100)
    fmt.Printf("  Total Earnings   : %.8f %s\n", status.TotalEarnings, status.Currency)
    fmt.Printf("  Active Workers   : %d\n", status.ActiveWorkers)
    fmt.Printf("  Connected Peers  : %d\n", status.ConnectedPeers)
    
    // Workers
    if len(status.Workers) > 0 {
        fmt.Println("\nWorkers:")
        for _, worker := range status.Workers {
            efficiency := float64(worker.Hashrate)
            if worker.Power > 0 {
                efficiency = efficiency / float64(worker.Power)
            }
            fmt.Printf("  - %s [%s] rate=%s temp=%d°C power=%dW eff=%.2f MH/W status=%s %s\n",
                worker.Name,
                worker.Type,
                humanize.SI(worker.Hashrate, "H/s"),
                worker.Temperature,
                worker.Power,
                efficiency/1e6,
                getWorkerStatusEmoji(worker.Status),
                worker.Status,
            )
        }
    }
    
    // Algorithms
    if len(status.Algorithms) > 0 {
        fmt.Println("\nAlgorithms:")
        for _, algo := range status.Algorithms {
            fmt.Printf("  - %-10s rate=%s shares=%d profit/day=%.4f %s\n",
                algo.Name,
                humanize.SI(algo.Hashrate, "H/s"),
                algo.Shares,
                algo.ProfitPerDay,
                status.Currency,
            )
        }
    }
    
    // Pool
    if status.Pool != nil {
        fmt.Println("\nPool:")
        fmt.Printf("  Name       : %s\n", status.Pool.Name)
        fmt.Printf("  Difficulty : %s\n", humanize.SI(status.Pool.Difficulty, ""))
        fmt.Printf("  RoundShare : %d\n", status.Pool.RoundShares)
        fmt.Printf("  Last Block : %s\n", humanize.Time(status.Pool.LastBlockTime))
        fmt.Printf("  Fee        : %.1f%%\n", status.Pool.Fee*100)
    }
    
    // Alerts
    if len(status.Alerts) > 0 {
        fmt.Println("\nAlerts:")
        for _, alert := range status.Alerts {
            marker := getAlertEmoji(alert.Severity)
            fmt.Printf("  %s [%s] %s - %s\n", marker, alert.Severity, alert.Message, humanize.Time(alert.Time))
        }
    }
    return nil
}

func displayJSON(status *MiningStatus) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(status)
}

func displayYAML(status *MiningStatus) error {
	data, err := yaml.Marshal(status)
	if err != nil {
		return err
	}
	fmt.Print(string(data))
	return nil
}

func getStatusEmoji(status string) string {
	switch status {
	case "running":
		return "[RUN]"
	case "stopped":
		return "[STOP]"
	case "paused":
		return "[PAUSE]"
	case "error":
		return "[ERROR]"
	default:
		return "[N/A]"
	}
}

func getWorkerStatusEmoji(status string) string {
	switch status {
	case "active":
		return "[OK]"
	case "idle":
		return "[IDLE]"
	case "error":
		return "[ERROR]"
	case "overheating":
		return "[HOT]"
	default:
		return "[N/A]"
	}
}

func getAlertEmoji(severity string) string {
	switch severity {
	case "critical":
		return "[CRIT]"
	case "warning":
		return "[WARN]"
	case "info":
		return "[INFO]"
	default:
		return "[NOTE]"
	}
}

// MiningStatus represents the current mining status
type MiningStatus struct {
	Status             string     `json:"status"`
	StartTime          time.Time  `json:"start_time"`
	TotalHashrate      float64    `json:"total_hashrate"`
	SharesAccepted     int64      `json:"shares_accepted"`
	SharesRejected     int64      `json:"shares_rejected"`
	SharesAcceptedRate float64    `json:"shares_accepted_rate"`
	SharesRejectedRate float64    `json:"shares_rejected_rate"`
	TotalEarnings      float64    `json:"total_earnings"`
	Currency           string     `json:"currency"`
	ActiveWorkers      int        `json:"active_workers"`
	ConnectedPeers     int        `json:"connected_peers"`
	Workers            []Worker   `json:"workers"`
	Algorithms         []Algorithm `json:"algorithms"`
	Pool               *PoolInfo  `json:"pool,omitempty"`
	Alerts             []Alert    `json:"alerts"`
}

// Worker represents a mining worker
type Worker struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"` // CPU, GPU, ASIC
	Hashrate    float64 `json:"hashrate"`
	Temperature int     `json:"temperature"`
	Power       int     `json:"power"`
	Status      string  `json:"status"`
}

// Algorithm represents mining algorithm stats
type Algorithm struct {
	Name         string  `json:"name"`
	Hashrate     float64 `json:"hashrate"`
	Shares       int64   `json:"shares"`
	ProfitPerDay float64 `json:"profit_per_day"`
}

// PoolInfo represents pool information
type PoolInfo struct {
	Name          string    `json:"name"`
	Difficulty    float64   `json:"difficulty"`
	RoundShares   int64     `json:"round_shares"`
	LastBlockTime time.Time `json:"last_block_time"`
	Fee           float64   `json:"fee"`
}

// Alert represents a system alert
type Alert struct {
	Severity string    `json:"severity"`
	Message  string    `json:"message"`
	Time     time.Time `json:"time"`
}