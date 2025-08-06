package analytics

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html/template"
	"time"

	"go.uber.org/zap"
)

// ReportGenerator generates various reports from analytics data
type ReportGenerator struct {
	logger    *zap.Logger
	analytics *AnalyticsEngine
}

// NewReportGenerator creates a new report generator
func NewReportGenerator(logger *zap.Logger, analytics *AnalyticsEngine) *ReportGenerator {
	return &ReportGenerator{
		logger:    logger,
		analytics: analytics,
	}
}

// ReportType defines the type of report
type ReportType string

const (
	DailyReport    ReportType = "daily"
	WeeklyReport   ReportType = "weekly"
	MonthlyReport  ReportType = "monthly"
	WorkerReport   ReportType = "worker"
	PayoutReport   ReportType = "payout"
	EfficiencyReport ReportType = "efficiency"
)

// ReportFormat defines the output format
type ReportFormat string

const (
	JSONFormat  ReportFormat = "json"
	CSVFormat   ReportFormat = "csv"
	HTMLFormat  ReportFormat = "html"
	PDFFormat   ReportFormat = "pdf"
)

// ReportRequest contains report generation parameters
type ReportRequest struct {
	Type      ReportType
	Format    ReportFormat
	Currency  string
	StartDate time.Time
	EndDate   time.Time
	WorkerID  string // For worker-specific reports
	Options   map[string]interface{}
}

// Report contains the generated report
type Report struct {
	ID         string
	Type       ReportType
	Format     ReportFormat
	Title      string
	Content    []byte
	Metadata   map[string]interface{}
	GeneratedAt time.Time
}

// GenerateReport generates a report based on the request
func (rg *ReportGenerator) GenerateReport(ctx context.Context, req ReportRequest) (*Report, error) {
	report := &Report{
		ID:          generateReportID(),
		Type:        req.Type,
		Format:      req.Format,
		GeneratedAt: time.Now(),
		Metadata:    make(map[string]interface{}),
	}
	
	// Generate report content based on type
	var data interface{}
	var err error
	
	switch req.Type {
	case DailyReport:
		data, err = rg.generateDailyReport(ctx, req)
		report.Title = fmt.Sprintf("Daily Report - %s", req.StartDate.Format("2006-01-02"))
		
	case WeeklyReport:
		data, err = rg.generateWeeklyReport(ctx, req)
		report.Title = fmt.Sprintf("Weekly Report - Week %d, %d", getWeekNumber(req.StartDate), req.StartDate.Year())
		
	case MonthlyReport:
		data, err = rg.generateMonthlyReport(ctx, req)
		report.Title = fmt.Sprintf("Monthly Report - %s", req.StartDate.Format("January 2006"))
		
	case WorkerReport:
		data, err = rg.generateWorkerReport(ctx, req)
		report.Title = fmt.Sprintf("Worker Report - %s", req.WorkerID)
		
	case PayoutReport:
		data, err = rg.generatePayoutReport(ctx, req)
		report.Title = "Payout Report"
		
	case EfficiencyReport:
		data, err = rg.generateEfficiencyReport(ctx, req)
		report.Title = "Efficiency Analysis Report"
		
	default:
		return nil, fmt.Errorf("unsupported report type: %s", req.Type)
	}
	
	if err != nil {
		return nil, err
	}
	
	// Format the report
	switch req.Format {
	case JSONFormat:
		report.Content, err = rg.formatAsJSON(data)
	case CSVFormat:
		report.Content, err = rg.formatAsCSV(data)
	case HTMLFormat:
		report.Content, err = rg.formatAsHTML(report.Title, data)
	case PDFFormat:
		// PDF generation would require additional library
		return nil, fmt.Errorf("PDF format not implemented")
	default:
		return nil, fmt.Errorf("unsupported format: %s", req.Format)
	}
	
	if err != nil {
		return nil, err
	}
	
	return report, nil
}

// Daily report generation
func (rg *ReportGenerator) generateDailyReport(ctx context.Context, req ReportRequest) (map[string]interface{}, error) {
	data := make(map[string]interface{})
	
	// Get pool statistics
	if req.Currency != "" {
		stats, err := rg.analytics.GetPoolStatistics(req.Currency)
		if err != nil {
			return nil, err
		}
		data["pool_statistics"] = stats
		
		// Get block statistics for the day
		blockStats, err := rg.analytics.GetBlockStatistics(req.Currency, 24*time.Hour)
		if err != nil {
			return nil, err
		}
		data["block_statistics"] = blockStats
		
		// Get payout statistics
		payoutStats, err := rg.analytics.GetPayoutStatistics(req.Currency, 24*time.Hour)
		if err != nil {
			return nil, err
		}
		data["payout_statistics"] = payoutStats
		
		// Get efficiency analysis
		efficiency, err := rg.analytics.GetEfficiencyAnalysis(req.Currency)
		if err != nil {
			return nil, err
		}
		data["efficiency"] = efficiency
		
		// Get top workers
		topWorkers, err := rg.analytics.GetWorkerRankings(req.Currency, "hashrate", 10)
		if err != nil {
			return nil, err
		}
		data["top_workers"] = topWorkers
	} else {
		// Global statistics
		globalStats, err := rg.analytics.GetGlobalStatistics()
		if err != nil {
			return nil, err
		}
		data = globalStats
	}
	
	data["report_date"] = req.StartDate.Format("2006-01-02")
	data["generated_at"] = time.Now()
	
	return data, nil
}

// Weekly report generation
func (rg *ReportGenerator) generateWeeklyReport(ctx context.Context, req ReportRequest) (map[string]interface{}, error) {
	data := make(map[string]interface{})
	
	// Get weekly trends
	if req.Currency != "" {
		trends, err := rg.analytics.GetCurrencyTrends(req.Currency)
		if err != nil {
			return nil, err
		}
		data["trends"] = trends
		
		// Get weekly summary statistics
		weeklyStats := make(map[string]interface{})
		
		// Calculate daily averages for the week
		for i := 0; i < 7; i++ {
			date := req.StartDate.AddDate(0, 0, i)
			dayStats, err := rg.analytics.GetPoolStatistics(req.Currency)
			if err != nil {
				continue
			}
			weeklyStats[date.Format("Monday")] = dayStats
		}
		
		data["daily_statistics"] = weeklyStats
		
		// Get block statistics for the week
		blockStats, err := rg.analytics.GetBlockStatistics(req.Currency, 7*24*time.Hour)
		if err != nil {
			return nil, err
		}
		data["block_statistics"] = blockStats
		
		// Get payout summary
		payoutStats, err := rg.analytics.GetPayoutStatistics(req.Currency, 7*24*time.Hour)
		if err != nil {
			return nil, err
		}
		data["payout_summary"] = payoutStats
	}
	
	data["week_number"] = getWeekNumber(req.StartDate)
	data["year"] = req.StartDate.Year()
	data["start_date"] = req.StartDate.Format("2006-01-02")
	data["end_date"] = req.EndDate.Format("2006-01-02")
	data["generated_at"] = time.Now()
	
	return data, nil
}

// Monthly report generation
func (rg *ReportGenerator) generateMonthlyReport(ctx context.Context, req ReportRequest) (map[string]interface{}, error) {
	data := make(map[string]interface{})
	
	if req.Currency != "" {
		// Get monthly statistics
		monthlyStats := make(map[string]interface{})
		
		// Get block statistics for the month
		blockStats, err := rg.analytics.GetBlockStatistics(req.Currency, 30*24*time.Hour)
		if err != nil {
			return nil, err
		}
		monthlyStats["blocks"] = blockStats
		
		// Get payout statistics
		payoutStats, err := rg.analytics.GetPayoutStatistics(req.Currency, 30*24*time.Hour)
		if err != nil {
			return nil, err
		}
		monthlyStats["payouts"] = payoutStats
		
		// Get efficiency trends
		efficiency, err := rg.analytics.GetEfficiencyAnalysis(req.Currency)
		if err != nil {
			return nil, err
		}
		monthlyStats["efficiency"] = efficiency
		
		// Get predictive analytics
		predictions, err := rg.analytics.GetPredictiveAnalytics(req.Currency)
		if err != nil {
			return nil, err
		}
		monthlyStats["predictions"] = predictions
		
		data["monthly_statistics"] = monthlyStats
		
		// Get top performers
		topHashrate, _ := rg.analytics.GetWorkerRankings(req.Currency, "hashrate", 20)
		topEarnings, _ := rg.analytics.GetWorkerRankings(req.Currency, "earnings", 20)
		topEfficiency, _ := rg.analytics.GetWorkerRankings(req.Currency, "efficiency", 20)
		
		data["top_performers"] = map[string]interface{}{
			"by_hashrate":   topHashrate,
			"by_earnings":   topEarnings,
			"by_efficiency": topEfficiency,
		}
	}
	
	data["month"] = req.StartDate.Format("January")
	data["year"] = req.StartDate.Year()
	data["generated_at"] = time.Now()
	
	return data, nil
}

// Worker report generation
func (rg *ReportGenerator) generateWorkerReport(ctx context.Context, req ReportRequest) (map[string]interface{}, error) {
	if req.WorkerID == "" {
		return nil, fmt.Errorf("worker ID required for worker report")
	}
	
	data := make(map[string]interface{})
	
	// Get worker statistics
	workerStats, err := rg.analytics.GetWorkerStatistics(req.WorkerID)
	if err != nil {
		return nil, err
	}
	data["statistics"] = workerStats
	
	// Get detailed performance metrics
	performance := map[string]interface{}{
		"average_hashrate":  workerStats.Hashrate,
		"total_shares":      workerStats.ValidShares + workerStats.InvalidShares,
		"valid_shares":      workerStats.ValidShares,
		"invalid_shares":    workerStats.InvalidShares,
		"efficiency":        workerStats.Efficiency,
		"total_earned":      workerStats.TotalEarned,
		"pending_balance":   workerStats.PendingBalance,
		"last_seen":         workerStats.LastShareTime,
	}
	data["performance"] = performance
	
	// Include share history if requested
	if include, ok := req.Options["include_share_history"].(bool); ok && include {
		data["share_history"] = workerStats.ShareHistory
	}
	
	// Include payout history if requested
	if include, ok := req.Options["include_payout_history"].(bool); ok && include {
		data["payout_history"] = workerStats.PayoutHistory
	}
	
	data["worker_id"] = req.WorkerID
	data["period_start"] = req.StartDate
	data["period_end"] = req.EndDate
	data["generated_at"] = time.Now()
	
	return data, nil
}

// Payout report generation
func (rg *ReportGenerator) generatePayoutReport(ctx context.Context, req ReportRequest) (map[string]interface{}, error) {
	data := make(map[string]interface{})
	
	// Get payout statistics for the period
	period := req.EndDate.Sub(req.StartDate)
	if period <= 0 {
		period = 24 * time.Hour
	}
	
	if req.Currency != "" {
		payoutStats, err := rg.analytics.GetPayoutStatistics(req.Currency, period)
		if err != nil {
			return nil, err
		}
		data["statistics"] = payoutStats
		
		// Get detailed payout list if requested
		if include, ok := req.Options["include_details"].(bool); ok && include {
			// This would fetch actual payout records
			data["payout_details"] = []interface{}{} // Placeholder
		}
		
		// Get payout distribution
		distribution := map[string]interface{}{
			"by_amount_range": getPayoutDistribution(),
			"by_worker_count": getWorkerPayoutDistribution(),
		}
		data["distribution"] = distribution
	}
	
	data["period_start"] = req.StartDate
	data["period_end"] = req.EndDate
	data["generated_at"] = time.Now()
	
	return data, nil
}

// Efficiency report generation
func (rg *ReportGenerator) generateEfficiencyReport(ctx context.Context, req ReportRequest) (map[string]interface{}, error) {
	data := make(map[string]interface{})
	
	if req.Currency != "" {
		// Get efficiency analysis
		efficiency, err := rg.analytics.GetEfficiencyAnalysis(req.Currency)
		if err != nil {
			return nil, err
		}
		data["overall_efficiency"] = efficiency
		
		// Get worker efficiency rankings
		efficiencyRanking, err := rg.analytics.GetWorkerRankings(req.Currency, "efficiency", 50)
		if err != nil {
			return nil, err
		}
		data["worker_rankings"] = efficiencyRanking
		
		// Get efficiency trends
		trends, err := rg.analytics.GetCurrencyTrends(req.Currency)
		if err != nil {
			return nil, err
		}
		data["efficiency_trends"] = trends.EfficiencyHistory
		
		// Calculate improvement opportunities
		improvements := calculateImprovementOpportunities(efficiency)
		data["improvement_opportunities"] = improvements
	}
	
	data["period"] = req.EndDate.Sub(req.StartDate).String()
	data["generated_at"] = time.Now()
	
	return data, nil
}

// Formatting methods

func (rg *ReportGenerator) formatAsJSON(data interface{}) ([]byte, error) {
	return json.MarshalIndent(data, "", "  ")
}

func (rg *ReportGenerator) formatAsCSV(data interface{}) ([]byte, error) {
	// Convert data to CSV format
	// This is simplified - actual implementation would handle complex data structures
	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	
	// Write headers and data based on data structure
	if mapData, ok := data.(map[string]interface{}); ok {
		headers := make([]string, 0, len(mapData))
		values := make([]string, 0, len(mapData))
		
		for key, value := range mapData {
			headers = append(headers, key)
			values = append(values, fmt.Sprintf("%v", value))
		}
		
		writer.Write(headers)
		writer.Write(values)
	}
	
	writer.Flush()
	return buf.Bytes(), nil
}

func (rg *ReportGenerator) formatAsHTML(title string, data interface{}) ([]byte, error) {
	tmplStr := `
<!DOCTYPE html>
<html>
<head>
    <title>{{.Title}}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1 { color: #333; }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #f2f2f2; font-weight: bold; }
        tr:nth-child(even) { background-color: #f9f9f9; }
        .metric { font-size: 24px; font-weight: bold; color: #007bff; }
        .section { margin: 30px 0; }
    </style>
</head>
<body>
    <h1>{{.Title}}</h1>
    <p>Generated at: {{.GeneratedAt}}</p>
    
    <div class="content">
        {{.Content}}
    </div>
</body>
</html>
`
	
	tmpl, err := template.New("report").Parse(tmplStr)
	if err != nil {
		return nil, err
	}
	
	var buf bytes.Buffer
	err = tmpl.Execute(&buf, map[string]interface{}{
		"Title":       title,
		"GeneratedAt": time.Now().Format("2006-01-02 15:04:05"),
		"Content":     formatDataAsHTML(data),
	})
	
	return buf.Bytes(), err
}

// Helper functions

func generateReportID() string {
	return fmt.Sprintf("report_%d", time.Now().UnixNano())
}

func getWeekNumber(date time.Time) int {
	_, week := date.ISOWeek()
	return week
}

func getPayoutDistribution() map[string]int {
	// Placeholder - would calculate actual distribution
	return map[string]int{
		"0-0.1":   45,
		"0.1-1":   30,
		"1-10":    20,
		"10+":     5,
	}
}

func getWorkerPayoutDistribution() map[string]int {
	// Placeholder - would calculate actual distribution
	return map[string]int{
		"1-5_payouts":   60,
		"6-10_payouts":  25,
		"11-20_payouts": 10,
		"20+_payouts":   5,
	}
}

func calculateImprovementOpportunities(efficiency map[string]interface{}) []map[string]interface{} {
	opportunities := []map[string]interface{}{}
	
	// Check share efficiency
	if shareEff, ok := efficiency["share_efficiency"].(float64); ok && shareEff < 99 {
		opportunities = append(opportunities, map[string]interface{}{
			"area":        "Share Efficiency",
			"current":     shareEff,
			"target":      99.0,
			"impact":      "High",
			"suggestion":  "Review miner configurations and network connectivity",
		})
	}
	
	// Check stale rate
	if staleRate, ok := efficiency["stale_rate"].(float64); ok && staleRate > 1 {
		opportunities = append(opportunities, map[string]interface{}{
			"area":        "Stale Share Rate",
			"current":     staleRate,
			"target":      0.5,
			"impact":      "Medium",
			"suggestion":  "Optimize job distribution and reduce network latency",
		})
	}
	
	return opportunities
}

func formatDataAsHTML(data interface{}) template.HTML {
	// Convert data to HTML format
	// This is simplified - actual implementation would create proper HTML tables and sections
	jsonData, _ := json.MarshalIndent(data, "", "  ")
	return template.HTML("<pre>" + string(jsonData) + "</pre>")
}