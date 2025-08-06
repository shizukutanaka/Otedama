package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/shizukutanaka/Otedama/internal/security"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func main() {
	var (
		projectPath    = flag.String("path", ".", "Path to project to scan")
		outputDir      = flag.String("output", "security_audit", "Output directory for reports")
		scanType       = flag.String("type", "all", "Type of scan: all, sast, deps, secrets, compliance")
		format         = flag.String("format", "json", "Output format: json, html, sarif")
		standards      = flag.String("standards", "", "Compliance standards to check (comma-separated)")
		verbose        = flag.Bool("verbose", false, "Enable verbose logging")
		failOnCritical = flag.Bool("fail-critical", true, "Exit with error on critical findings")
	)
	
	flag.Parse()
	
	// Setup logger
	config := zap.NewProductionConfig()
	if *verbose {
		config.Level = zap.NewAtomicLevelAt(zapcore.DebugLevel)
	}
	
	logger, err := config.Build()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync()
	
	// Create output directory
	if err := os.MkdirAll(*outputDir, 0755); err != nil {
		logger.Fatal("Failed to create output directory", zap.Error(err))
	}
	
	// Track overall results
	auditResults := &AuditResults{
		StartTime: time.Now(),
		Path:      *projectPath,
		Type:      *scanType,
	}
	
	// Run scans based on type
	switch *scanType {
	case "all":
		runAllScans(logger, *projectPath, *outputDir, *format, *standards, auditResults)
	case "sast":
		runSAST(logger, *projectPath, *outputDir, *format, auditResults)
	case "deps":
		runDependencyScan(logger, *projectPath, *outputDir, *format, auditResults)
	case "secrets":
		runSecretScan(logger, *projectPath, *outputDir, *format, auditResults)
	case "compliance":
		runComplianceScan(logger, *projectPath, *outputDir, *format, *standards, auditResults)
	default:
		logger.Fatal("Invalid scan type", zap.String("type", *scanType))
	}
	
	// Generate summary report
	auditResults.EndTime = time.Now()
	auditResults.Duration = auditResults.EndTime.Sub(auditResults.StartTime)
	
	summaryPath := filepath.Join(*outputDir, "audit_summary.json")
	if err := generateSummary(auditResults, summaryPath); err != nil {
		logger.Error("Failed to generate summary", zap.Error(err))
	}
	
	// Print summary to console
	printSummary(auditResults)
	
	// Exit with error if critical issues found
	if *failOnCritical && auditResults.CriticalCount > 0 {
		os.Exit(1)
	}
}

// AuditResults tracks overall audit results
type AuditResults struct {
	StartTime      time.Time     `json:"start_time"`
	EndTime        time.Time     `json:"end_time"`
	Duration       time.Duration `json:"duration"`
	Path           string        `json:"path"`
	Type           string        `json:"type"`
	TotalIssues    int           `json:"total_issues"`
	CriticalCount  int           `json:"critical_count"`
	HighCount      int           `json:"high_count"`
	MediumCount    int           `json:"medium_count"`
	LowCount       int           `json:"low_count"`
	SecurityScore  float64       `json:"security_score"`
	ComplianceScore float64      `json:"compliance_score"`
}

func runAllScans(logger *zap.Logger, projectPath, outputDir, format, standards string, results *AuditResults) {
	logger.Info("Running comprehensive security audit")
	
	// Run each scan type
	runSAST(logger, projectPath, outputDir, format, results)
	runDependencyScan(logger, projectPath, outputDir, format, results)
	runSecretScan(logger, projectPath, outputDir, format, results)
	runComplianceScan(logger, projectPath, outputDir, format, standards, results)
}

func runSAST(logger *zap.Logger, projectPath, outputDir, format string, results *AuditResults) {
	logger.Info("Running static application security testing (SAST)")
	
	scanner := security.NewAdvancedScanner(logger)
	
	// Scan directory
	if err := scanner.ScanDirectory(projectPath); err != nil {
		logger.Error("SAST scan failed", zap.Error(err))
		return
	}
	
	// Get issues
	issues := scanner.GetIssues()
	
	// Update results
	for _, issue := range issues {
		results.TotalIssues++
		switch issue.Severity {
		case "CRITICAL":
			results.CriticalCount++
		case "HIGH":
			results.HighCount++
		case "MEDIUM":
			results.MediumCount++
		case "LOW":
			results.LowCount++
		}
	}
	
	// Calculate security score
	results.SecurityScore = scanner.GetSecurityScore()
	
	// Generate report
	reportPath := filepath.Join(outputDir, fmt.Sprintf("sast_report.%s", getFileExtension(format)))
	
	switch format {
	case "json":
		exportJSON(issues, reportPath)
	case "sarif":
		exportSARIF(issues, reportPath)
	default:
		if err := scanner.GenerateReport(reportPath); err != nil {
			logger.Error("Failed to generate SAST report", zap.Error(err))
		}
	}
	
	logger.Info("SAST scan completed", 
		zap.Int("issues", len(issues)),
		zap.Float64("security_score", results.SecurityScore))
}

func runDependencyScan(logger *zap.Logger, projectPath, outputDir, format string, results *AuditResults) {
	logger.Info("Running dependency vulnerability scan")
	
	config := &security.DependencyScanConfig{
		CheckLicenses: true,
		CheckOutdated: true,
		MaxCVSS:      7.0,
	}
	
	scanner := security.NewDependencyScanner(logger, config)
	
	// Scan Go modules
	if err := scanner.ScanGoModules(projectPath); err != nil {
		logger.Error("Go module scan failed", zap.Error(err))
	}
	
	// Scan NPM packages
	if err := scanner.ScanNPMPackages(projectPath); err != nil {
		logger.Error("NPM package scan failed", zap.Error(err))
	}
	
	// Generate report
	report := scanner.GenerateReport()
	
	// Update results
	results.TotalIssues += len(report.Critical) + len(report.High) + len(report.Medium) + len(report.Low)
	results.CriticalCount += len(report.Critical)
	results.HighCount += len(report.High)
	results.MediumCount += len(report.Medium)
	results.LowCount += len(report.Low)
	
	// Export report
	reportPath := filepath.Join(outputDir, fmt.Sprintf("dependency_report.%s", getFileExtension(format)))
	exportJSON(report, reportPath)
	
	// Export SBOM
	sbomPath := filepath.Join(outputDir, "sbom.json")
	sbomFile, err := os.Create(sbomPath)
	if err == nil {
		scanner.ExportSBOM("cyclonedx", sbomFile)
		sbomFile.Close()
	}
	
	logger.Info("Dependency scan completed",
		zap.Int("total_deps", report.TotalDeps),
		zap.Int("vulnerabilities", results.TotalIssues),
		zap.Float64("risk_score", report.RiskScore))
}

func runSecretScan(logger *zap.Logger, projectPath, outputDir, format string, results *AuditResults) {
	logger.Info("Running secret detection scan")
	
	// Use the advanced scanner's secret detection
	scanner := security.NewAdvancedScanner(logger)
	
	// Scan for secrets
	if err := scanner.ScanDirectory(projectPath); err != nil {
		logger.Error("Secret scan failed", zap.Error(err))
		return
	}
	
	// Filter for secret-related issues
	allIssues := scanner.GetIssues()
	secretIssues := []security.SecurityIssue{}
	
	for _, issue := range allIssues {
		if issue.Type == "Exposed Secret" || issue.Type == "Hardcoded Secret" || issue.Type == "Hardcoded Credential" {
			secretIssues = append(secretIssues, issue)
			results.TotalIssues++
			if issue.Severity == "CRITICAL" {
				results.CriticalCount++
			}
		}
	}
	
	// Export report
	reportPath := filepath.Join(outputDir, fmt.Sprintf("secrets_report.%s", getFileExtension(format)))
	exportJSON(secretIssues, reportPath)
	
	logger.Info("Secret scan completed", zap.Int("secrets_found", len(secretIssues)))
}

func runComplianceScan(logger *zap.Logger, projectPath, outputDir, format, standards string, results *AuditResults) {
	logger.Info("Running compliance scan")
	
	checker := security.NewComplianceChecker(logger, projectPath)
	
	// Parse standards
	var standardsList []security.ComplianceStandard
	if standards != "" {
		for _, std := range strings.Split(standards, ",") {
			switch strings.TrimSpace(std) {
			case "OWASP":
				standardsList = append(standardsList, security.StandardOWASP)
			case "PCI-DSS":
				standardsList = append(standardsList, security.StandardPCIDSS)
			case "GDPR":
				standardsList = append(standardsList, security.StandardGDPR)
			case "SOC2":
				standardsList = append(standardsList, security.StandardSOC2)
			case "HIPAA":
				standardsList = append(standardsList, security.StandardHIPAA)
			case "ISO27001":
				standardsList = append(standardsList, security.StandardISO27001)
			case "NIST":
				standardsList = append(standardsList, security.StandardNIST)
			case "CIS":
				standardsList = append(standardsList, security.StandardCIS)
			}
		}
	}
	
	// Run compliance checks
	if err := checker.CheckCompliance(standardsList...); err != nil {
		logger.Error("Compliance check failed", zap.Error(err))
		return
	}
	
	// Generate report
	report, err := checker.GenerateReport()
	if err != nil {
		logger.Error("Failed to generate compliance report", zap.Error(err))
		return
	}
	
	// Calculate overall compliance score
	totalScore := 0.0
	standardCount := 0
	for _, stdReport := range report.Standards {
		totalScore += stdReport.ComplianceScore
		standardCount++
		
		// Update issue counts
		results.TotalIssues += stdReport.Failed
		results.HighCount += stdReport.Failed // Consider compliance failures as high priority
	}
	
	if standardCount > 0 {
		results.ComplianceScore = totalScore / float64(standardCount)
	}
	
	// Export report
	reportPath := filepath.Join(outputDir, fmt.Sprintf("compliance_report.%s", getFileExtension(format)))
	
	switch format {
	case "json":
		checker.ExportReport("json", reportPath)
	case "html":
		checker.ExportReport("html", reportPath)
	default:
		checker.ExportReport("json", reportPath)
	}
	
	logger.Info("Compliance scan completed",
		zap.Int("standards_checked", standardCount),
		zap.Float64("compliance_score", results.ComplianceScore))
}

func generateSummary(results *AuditResults, outputPath string) error {
	file, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(results)
}

func printSummary(results *AuditResults) {
	fmt.Println("\n========================================")
	fmt.Println("       SECURITY AUDIT SUMMARY")
	fmt.Println("========================================")
	fmt.Printf("Path: %s\n", results.Path)
	fmt.Printf("Duration: %s\n", results.Duration.Round(time.Second))
	fmt.Printf("Total Issues: %d\n", results.TotalIssues)
	fmt.Println("\nIssue Breakdown:")
	fmt.Printf("  🚨 Critical: %d\n", results.CriticalCount)
	fmt.Printf("  ❌ High:     %d\n", results.HighCount)
	fmt.Printf("  ⚠️  Medium:   %d\n", results.MediumCount)
	fmt.Printf("  ℹ️  Low:      %d\n", results.LowCount)
	
	if results.SecurityScore > 0 {
		fmt.Printf("\nSecurity Score: %.1f/100\n", results.SecurityScore)
	}
	
	if results.ComplianceScore > 0 {
		fmt.Printf("Compliance Score: %.1f%%\n", results.ComplianceScore)
	}
	
	// Grade
	grade := calculateGrade(results)
	fmt.Printf("\nOverall Grade: %s\n", grade)
	fmt.Println("========================================")
	
	if results.CriticalCount > 0 {
		fmt.Println("\n⚠️  CRITICAL ISSUES FOUND - IMMEDIATE ACTION REQUIRED!")
	}
}

func calculateGrade(results *AuditResults) string {
	// Use security score if available, otherwise calculate from issues
	score := results.SecurityScore
	if score == 0 && results.TotalIssues > 0 {
		// Simple scoring based on issues
		score = 100.0
		score -= float64(results.CriticalCount) * 20
		score -= float64(results.HighCount) * 10
		score -= float64(results.MediumCount) * 5
		score -= float64(results.LowCount) * 2
		
		if score < 0 {
			score = 0
		}
	}
	
	switch {
	case score >= 90:
		return "A"
	case score >= 80:
		return "B"
	case score >= 70:
		return "C"
	case score >= 60:
		return "D"
	default:
		return "F"
	}
}

func getFileExtension(format string) string {
	switch format {
	case "sarif":
		return "sarif"
	case "html":
		return "html"
	default:
		return "json"
	}
}

func exportJSON(data interface{}, outputPath string) error {
	file, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(data)
}

func exportSARIF(issues []security.SecurityIssue, outputPath string) error {
	// Convert to SARIF format
	sarif := map[string]interface{}{
		"version": "2.1.0",
		"runs": []map[string]interface{}{
			{
				"tool": map[string]interface{}{
					"driver": map[string]interface{}{
						"name":    "Otedama Security Scanner",
						"version": "1.0.0",
						"rules":   []map[string]interface{}{},
					},
				},
				"results": []map[string]interface{}{},
			},
		},
	}
	
	// Convert issues to SARIF results
	run := sarif["runs"].([]map[string]interface{})[0]
	results := []map[string]interface{}{}
	
	for _, issue := range issues {
		result := map[string]interface{}{
			"ruleId":  issue.Rule,
			"level":   severityToSARIFLevel(issue.Severity),
			"message": map[string]interface{}{
				"text": issue.Message,
			},
			"locations": []map[string]interface{}{
				{
					"physicalLocation": map[string]interface{}{
						"artifactLocation": map[string]interface{}{
							"uri": issue.File,
						},
						"region": map[string]interface{}{
							"startLine":   issue.Line,
							"startColumn": issue.Column,
						},
					},
				},
			},
		}
		
		results = append(results, result)
	}
	
	run["results"] = results
	
	return exportJSON(sarif, outputPath)
}

func severityToSARIFLevel(severity string) string {
	switch severity {
	case "CRITICAL", "HIGH":
		return "error"
	case "MEDIUM":
		return "warning"
	case "LOW":
		return "note"
	default:
		return "none"
	}
}