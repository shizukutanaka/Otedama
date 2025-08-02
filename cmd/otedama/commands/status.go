package commands

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/dustin/go-humanize"
	"github.com/olekukonko/tablewriter"
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
	
	// Overview table
	overviewTable := tablewriter.NewWriter(os.Stdout)
	overviewTable.SetHeader([]string{"Metric", "Value"})
	overviewTable.SetBorder(false)
	
	overviewData := [][]string{
		{"Status", getStatusEmoji(status.Status) + " " + status.Status},
		{"Uptime", humanize.Time(status.StartTime)},
		{"Total Hashrate", humanize.SI(status.TotalHashrate, "H/s")},
		{"Shares Accepted", fmt.Sprintf("%d (%.1f%%)", status.SharesAccepted, status.SharesAcceptedRate*100)},
		{"Shares Rejected", fmt.Sprintf("%d (%.1f%%)", status.SharesRejected, status.SharesRejectedRate*100)},
		{"Total Earnings", fmt.Sprintf("%.8f %s", status.TotalEarnings, status.Currency)},
		{"Active Workers", fmt.Sprintf("%d", status.ActiveWorkers)},
		{"Connected Peers", fmt.Sprintf("%d", status.ConnectedPeers)},
	}
	
	for _, v := range overviewData {
		overviewTable.Append(v)
	}
	overviewTable.Render()
	
	// Workers table
	if len(status.Workers) > 0 {
		fmt.Println("\nWorkers:")
		workersTable := tablewriter.NewWriter(os.Stdout)
		workersTable.SetHeader([]string{"Name", "Type", "Hashrate", "Temp", "Power", "Efficiency", "Status"})
		
		for _, worker := range status.Workers {
			efficiency := float64(worker.Hashrate) / float64(worker.Power)
			workersTable.Append([]string{
				worker.Name,
				worker.Type,
				humanize.SI(worker.Hashrate, "H/s"),
				fmt.Sprintf("%d°C", worker.Temperature),
				fmt.Sprintf("%dW", worker.Power),
				fmt.Sprintf("%.2f MH/W", efficiency/1e6),
				getWorkerStatusEmoji(worker.Status) + " " + worker.Status,
			})
		}
		workersTable.Render()
	}
	
	// Algorithms table
	if len(status.Algorithms) > 0 {
		fmt.Println("\nAlgorithms:")
		algoTable := tablewriter.NewWriter(os.Stdout)
		algoTable.SetHeader([]string{"Algorithm", "Hashrate", "Shares", "Profit/Day"})
		
		for _, algo := range status.Algorithms {
			algoTable.Append([]string{
				algo.Name,
				humanize.SI(algo.Hashrate, "H/s"),
				fmt.Sprintf("%d", algo.Shares),
				fmt.Sprintf("%.4f %s", algo.ProfitPerDay, status.Currency),
			})
		}
		algoTable.Render()
	}
	
	// Pool information
	if status.Pool != nil {
		fmt.Println("\nPool Information:")
		poolTable := tablewriter.NewWriter(os.Stdout)
		poolTable.SetHeader([]string{"Metric", "Value"})
		poolTable.SetBorder(false)
		
		poolData := [][]string{
			{"Pool", status.Pool.Name},
			{"Difficulty", humanize.SI(status.Pool.Difficulty, "")},
			{"Round Shares", fmt.Sprintf("%d", status.Pool.RoundShares)},
			{"Last Block", humanize.Time(status.Pool.LastBlockTime)},
			{"Pool Fee", fmt.Sprintf("%.1f%%", status.Pool.Fee*100)},
		}
		
		for _, v := range poolData {
			poolTable.Append(v)
		}
		poolTable.Render()
	}
	
	// Alerts
	if len(status.Alerts) > 0 {
		fmt.Println("\nAlerts:")
		for _, alert := range status.Alerts {
			emoji := getAlertEmoji(alert.Severity)
			fmt.Printf("%s [%s] %s - %s\n", emoji, alert.Severity, alert.Message, humanize.Time(alert.Time))
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
		return "🟢"
	case "stopped":
		return "🔴"
	case "paused":
		return "⏸️"
	case "error":
		return "❌"
	default:
		return "❓"
	}
}

func getWorkerStatusEmoji(status string) string {
	switch status {
	case "active":
		return "✅"
	case "idle":
		return "💤"
	case "error":
		return "❌"
	case "overheating":
		return "🔥"
	default:
		return "❓"
	}
}

func getAlertEmoji(severity string) string {
	switch severity {
	case "critical":
		return "🚨"
	case "warning":
		return "⚠️"
	case "info":
		return "ℹ️"
	default:
		return "📌"
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