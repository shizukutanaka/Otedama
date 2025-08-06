package security

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"go.uber.org/zap"
)

// SmartContractSecurityManager provides smart contract security features
type SmartContractSecurityManager struct {
	logger *zap.Logger
	
	// Security scanners
	staticAnalyzer   *StaticAnalyzer
	runtimeMonitor   *RuntimeMonitor
	vulnerabilityDB  *VulnerabilityDatabase
	
	// Protection mechanisms
	reentrancyGuard  *ReentrancyGuard
	accessController *AccessController
	rateLimit        *ContractRateLimiter
	pausable         *PausableController
	
	// Audit and monitoring
	auditLogger      *ContractAuditLogger
	gasMonitor       *GasMonitor
	
	// Configuration
	config           ContractSecurityConfig
	
	// Metrics
	metrics          struct {
		vulnerabilitiesDetected uint64
		attacksBlocked         uint64
		contractsPaused        uint64
		gasAnomalies          uint64
	}
}

// ContractSecurityConfig defines security configuration
type ContractSecurityConfig struct {
	// Analysis settings
	EnableStaticAnalysis   bool     `json:"enable_static_analysis"`
	EnableRuntimeMonitor   bool     `json:"enable_runtime_monitor"`
	VulnerabilityDBPath    string   `json:"vulnerability_db_path"`
	
	// Protection settings
	EnableReentrancyGuard  bool     `json:"enable_reentrancy_guard"`
	EnableAccessControl    bool     `json:"enable_access_control"`
	EnableRateLimit        bool     `json:"enable_rate_limit"`
	EnablePausable         bool     `json:"enable_pausable"`
	
	// Thresholds
	MaxGasPrice            *big.Int `json:"max_gas_price"`
	MaxTransactionValue    *big.Int `json:"max_transaction_value"`
	SuspiciousGasThreshold uint64   `json:"suspicious_gas_threshold"`
	
	// Monitoring
	MonitorInterval        time.Duration `json:"monitor_interval"`
	AlertThreshold         int      `json:"alert_threshold"`
}

// Vulnerability represents a smart contract vulnerability
type Vulnerability struct {
	ID          string
	Name        string
	Severity    VulnerabilitySeverity
	Category    VulnerabilityCategory
	Description string
	Pattern     *regexp.Regexp
	Remediation string
}

// VulnerabilitySeverity levels
type VulnerabilitySeverity int

const (
	SeverityLow VulnerabilitySeverity = iota
	SeverityMedium
	SeverityHigh
	SeverityCritical
)

// VulnerabilityCategory types
type VulnerabilityCategory string

const (
	CategoryReentrancy     VulnerabilityCategory = "reentrancy"
	CategoryOverflow       VulnerabilityCategory = "overflow"
	CategoryAccessControl  VulnerabilityCategory = "access_control"
	CategoryUncheckedCall  VulnerabilityCategory = "unchecked_call"
	CategoryDelegateCall   VulnerabilityCategory = "delegate_call"
	CategoryTimestamp      VulnerabilityCategory = "timestamp"
	CategoryRandomness     VulnerabilityCategory = "randomness"
	CategoryDOS            VulnerabilityCategory = "dos"
	CategoryFrontRunning   VulnerabilityCategory = "front_running"
)

// StaticAnalyzer performs static code analysis
type StaticAnalyzer struct {
	logger          *zap.Logger
	vulnerabilities []Vulnerability
	patterns        map[VulnerabilityCategory][]*regexp.Regexp
}

// RuntimeMonitor monitors contract execution
type RuntimeMonitor struct {
	logger         *zap.Logger
	contracts      map[common.Address]*ContractMonitor
	mu             sync.RWMutex
	alertChannel   chan SecurityAlert
}

// ContractMonitor tracks individual contract behavior
type ContractMonitor struct {
	Address            common.Address
	TransactionCount   uint64
	LastTransaction    time.Time
	GasUsage           []uint64
	ValueTransferred   *big.Int
	SuspiciousActivity []SuspiciousActivity
}

// SuspiciousActivity represents detected suspicious behavior
type SuspiciousActivity struct {
	Type        string
	Description string
	Timestamp   time.Time
	TxHash      common.Hash
	Severity    VulnerabilitySeverity
}

// SecurityAlert represents a security alert
type SecurityAlert struct {
	Contract    common.Address
	AlertType   string
	Severity    VulnerabilitySeverity
	Description string
	Timestamp   time.Time
	Evidence    map[string]interface{}
}

// ReentrancyGuard prevents reentrancy attacks
type ReentrancyGuard struct {
	mu       sync.Mutex
	entering map[string]bool
}

// AccessController manages contract access control
type AccessController struct {
	mu          sync.RWMutex
	roles       map[common.Address][]string
	permissions map[string][]Permission
}

// ContractRateLimiter limits contract interactions
type ContractRateLimiter struct {
	mu      sync.RWMutex
	limits  map[common.Address]*RateLimit
	buckets map[common.Address]*TokenBucket
}

// RateLimit defines rate limiting rules
type RateLimit struct {
	CallsPerMinute   int
	ValuePerHour     *big.Int
	GasPerBlock      uint64
}

// PausableController manages contract pausing
type PausableController struct {
	mu            sync.RWMutex
	pausedContracts map[common.Address]PauseInfo
}

// PauseInfo contains pause information
type PauseInfo struct {
	PausedAt   time.Time
	PausedBy   common.Address
	Reason     string
	AutoResume time.Time
}

// NewSmartContractSecurityManager creates a new security manager
func NewSmartContractSecurityManager(logger *zap.Logger, config ContractSecurityConfig) *SmartContractSecurityManager {
	scsm := &SmartContractSecurityManager{
		logger: logger,
		config: config,
	}
	
	// Initialize components
	if config.EnableStaticAnalysis {
		scsm.staticAnalyzer = scsm.initializeStaticAnalyzer()
	}
	
	if config.EnableRuntimeMonitor {
		scsm.runtimeMonitor = scsm.initializeRuntimeMonitor()
	}
	
	scsm.vulnerabilityDB = scsm.initializeVulnerabilityDB()
	
	// Initialize protection mechanisms
	if config.EnableReentrancyGuard {
		scsm.reentrancyGuard = &ReentrancyGuard{
			entering: make(map[string]bool),
		}
	}
	
	if config.EnableAccessControl {
		scsm.accessController = &AccessController{
			roles:       make(map[common.Address][]string),
			permissions: make(map[string][]Permission),
		}
	}
	
	if config.EnableRateLimit {
		scsm.rateLimit = &ContractRateLimiter{
			limits:  make(map[common.Address]*RateLimit),
			buckets: make(map[common.Address]*TokenBucket),
		}
	}
	
	if config.EnablePausable {
		scsm.pausable = &PausableController{
			pausedContracts: make(map[common.Address]PauseInfo),
		}
	}
	
	// Initialize monitoring
	scsm.auditLogger = NewContractAuditLogger(logger)
	scsm.gasMonitor = NewGasMonitor(logger, config.SuspiciousGasThreshold)
	
	return scsm
}

// initializeStaticAnalyzer sets up static analysis patterns
func (scsm *SmartContractSecurityManager) initializeStaticAnalyzer() *StaticAnalyzer {
	sa := &StaticAnalyzer{
		logger:   scsm.logger,
		patterns: make(map[VulnerabilityCategory][]*regexp.Regexp),
	}
	
	// Define vulnerability patterns
	sa.vulnerabilities = []Vulnerability{
		{
			ID:       "REENTRANCY-001",
			Name:     "Reentrancy Vulnerability",
			Severity: SeverityCritical,
			Category: CategoryReentrancy,
			Pattern:  regexp.MustCompile(`\.call\{.*value:.*\}\(.*\).*state\s*=`),
			Description: "External call before state update detected",
			Remediation: "Use checks-effects-interactions pattern",
		},
		{
			ID:       "OVERFLOW-001",
			Name:     "Integer Overflow",
			Severity: SeverityHigh,
			Category: CategoryOverflow,
			Pattern:  regexp.MustCompile(`\+\+|--|\+=|-=|\*=`),
			Description: "Unchecked arithmetic operation detected",
			Remediation: "Use SafeMath library or Solidity 0.8+",
		},
		{
			ID:       "ACCESS-001",
			Name:     "Missing Access Control",
			Severity: SeverityHigh,
			Category: CategoryAccessControl,
			Pattern:  regexp.MustCompile(`function\s+\w+\s*\([^)]*\)\s*(public|external)(?!.*onlyOwner|require\(msg\.sender)`),
			Description: "Public function without access control",
			Remediation: "Add appropriate access modifiers",
		},
		{
			ID:       "DELEGATECALL-001",
			Name:     "Dangerous Delegate Call",
			Severity: SeverityCritical,
			Category: CategoryDelegateCall,
			Pattern:  regexp.MustCompile(`delegatecall\(`),
			Description: "Delegate call usage detected",
			Remediation: "Ensure delegate call target is trusted",
		},
		{
			ID:       "TIMESTAMP-001",
			Name:     "Timestamp Dependency",
			Severity: SeverityMedium,
			Category: CategoryTimestamp,
			Pattern:  regexp.MustCompile(`block\.timestamp|now`),
			Description: "Block timestamp dependency detected",
			Remediation: "Avoid using block.timestamp for critical logic",
		},
		{
			ID:       "RANDOMNESS-001",
			Name:     "Weak Randomness",
			Severity: SeverityHigh,
			Category: CategoryRandomness,
			Pattern:  regexp.MustCompile(`block\.timestamp.*%|block\.number.*%|blockhash\(`),
			Description: "Weak randomness source detected",
			Remediation: "Use Chainlink VRF or commit-reveal scheme",
		},
	}
	
	// Group patterns by category
	for _, vuln := range sa.vulnerabilities {
		sa.patterns[vuln.Category] = append(sa.patterns[vuln.Category], vuln.Pattern)
	}
	
	return sa
}

// initializeRuntimeMonitor sets up runtime monitoring
func (scsm *SmartContractSecurityManager) initializeRuntimeMonitor() *RuntimeMonitor {
	rm := &RuntimeMonitor{
		logger:       scsm.logger,
		contracts:    make(map[common.Address]*ContractMonitor),
		alertChannel: make(chan SecurityAlert, 100),
	}
	
	// Start monitoring goroutine
	go rm.monitorLoop(scsm.config.MonitorInterval)
	
	return rm
}

// initializeVulnerabilityDB loads vulnerability database
func (scsm *SmartContractSecurityManager) initializeVulnerabilityDB() *VulnerabilityDatabase {
	return &VulnerabilityDatabase{
		vulnerabilities: make(map[string]Vulnerability),
		signatures:      make(map[string]VulnerabilitySignature),
	}
}

// AnalyzeContract performs static analysis on contract code
func (scsm *SmartContractSecurityManager) AnalyzeContract(ctx context.Context, contractCode string) (*SecurityReport, error) {
	if scsm.staticAnalyzer == nil {
		return nil, errors.New("static analyzer not enabled")
	}
	
	report := &SecurityReport{
		Timestamp:       time.Now(),
		Vulnerabilities: []DetectedVulnerability{},
	}
	
	// Analyze code for each vulnerability pattern
	for _, vuln := range scsm.staticAnalyzer.vulnerabilities {
		matches := vuln.Pattern.FindAllStringIndex(contractCode, -1)
		
		for _, match := range matches {
			// Extract context around match
			start := max(0, match[0]-50)
			end := min(len(contractCode), match[1]+50)
			context := contractCode[start:end]
			
			detected := DetectedVulnerability{
				Vulnerability: vuln,
				Location:      match[0],
				Context:       context,
				Confidence:    scsm.calculateConfidence(vuln, context),
			}
			
			report.Vulnerabilities = append(report.Vulnerabilities, detected)
			scsm.metrics.vulnerabilitiesDetected++
		}
	}
	
	// Calculate overall risk score
	report.RiskScore = scsm.calculateRiskScore(report.Vulnerabilities)
	
	// Log findings
	if len(report.Vulnerabilities) > 0 {
		scsm.logger.Warn("Vulnerabilities detected in contract",
			zap.Int("count", len(report.Vulnerabilities)),
			zap.Float64("risk_score", report.RiskScore),
		)
	}
	
	return report, nil
}

// MonitorTransaction monitors transaction for security issues
func (scsm *SmartContractSecurityManager) MonitorTransaction(ctx context.Context, tx *types.Transaction, receipt *types.Receipt) error {
	if scsm.runtimeMonitor == nil {
		return errors.New("runtime monitor not enabled")
	}
	
	// Extract contract address
	var contractAddr common.Address
	if tx.To() != nil {
		contractAddr = *tx.To()
	} else if receipt != nil {
		contractAddr = receipt.ContractAddress
	}
	
	// Get or create contract monitor
	monitor := scsm.runtimeMonitor.getOrCreateMonitor(contractAddr)
	
	// Update transaction metrics
	monitor.TransactionCount++
	monitor.LastTransaction = time.Now()
	monitor.GasUsage = append(monitor.GasUsage, receipt.GasUsed)
	
	// Check for suspicious patterns
	suspicious := scsm.checkSuspiciousPatterns(tx, receipt, monitor)
	if len(suspicious) > 0 {
		monitor.SuspiciousActivity = append(monitor.SuspiciousActivity, suspicious...)
		
		// Send alerts for critical issues
		for _, activity := range suspicious {
			if activity.Severity >= SeverityHigh {
				alert := SecurityAlert{
					Contract:    contractAddr,
					AlertType:   activity.Type,
					Severity:    activity.Severity,
					Description: activity.Description,
					Timestamp:   activity.Timestamp,
					Evidence: map[string]interface{}{
						"tx_hash": tx.Hash().Hex(),
						"gas_used": receipt.GasUsed,
					},
				}
				
				select {
				case scsm.runtimeMonitor.alertChannel <- alert:
				default:
					scsm.logger.Warn("Alert channel full, dropping alert")
				}
			}
		}
	}
	
	// Check rate limits
	if scsm.rateLimit != nil {
		if err := scsm.rateLimit.CheckLimit(contractAddr, tx); err != nil {
			scsm.metrics.attacksBlocked++
			return err
		}
	}
	
	// Audit log
	scsm.auditLogger.LogTransaction(contractAddr, tx, receipt)
	
	return nil
}

// checkSuspiciousPatterns checks for suspicious transaction patterns
func (scsm *SmartContractSecurityManager) checkSuspiciousPatterns(tx *types.Transaction, receipt *types.Receipt, monitor *ContractMonitor) []SuspiciousActivity {
	var suspicious []SuspiciousActivity
	
	// Check gas anomalies
	if receipt.GasUsed > scsm.config.SuspiciousGasThreshold {
		suspicious = append(suspicious, SuspiciousActivity{
			Type:        "gas_anomaly",
			Description: fmt.Sprintf("Unusually high gas usage: %d", receipt.GasUsed),
			Timestamp:   time.Now(),
			TxHash:      tx.Hash(),
			Severity:    SeverityMedium,
		})
		scsm.metrics.gasAnomalies++
	}
	
	// Check transaction value
	if tx.Value() != nil && tx.Value().Cmp(scsm.config.MaxTransactionValue) > 0 {
		suspicious = append(suspicious, SuspiciousActivity{
			Type:        "high_value",
			Description: fmt.Sprintf("High value transaction: %s", tx.Value().String()),
			Timestamp:   time.Now(),
			TxHash:      tx.Hash(),
			Severity:    SeverityHigh,
		})
	}
	
	// Check rapid transactions (potential attack)
	if monitor.TransactionCount > 1 {
		timeSinceLast := time.Since(monitor.LastTransaction)
		if timeSinceLast < 1*time.Second {
			suspicious = append(suspicious, SuspiciousActivity{
				Type:        "rapid_transactions",
				Description: "Multiple transactions in rapid succession",
				Timestamp:   time.Now(),
				TxHash:      tx.Hash(),
				Severity:    SeverityHigh,
			})
		}
	}
	
	// Check for failed transactions pattern
	if receipt.Status == 0 {
		suspicious = append(suspicious, SuspiciousActivity{
			Type:        "failed_transaction",
			Description: "Transaction failed",
			Timestamp:   time.Now(),
			TxHash:      tx.Hash(),
			Severity:    SeverityLow,
		})
	}
	
	return suspicious
}

// CheckReentrancy checks for reentrancy in function call
func (scsm *SmartContractSecurityManager) CheckReentrancy(contractAddr common.Address, functionSig string) error {
	if scsm.reentrancyGuard == nil {
		return nil
	}
	
	key := fmt.Sprintf("%s:%s", contractAddr.Hex(), functionSig)
	
	scsm.reentrancyGuard.mu.Lock()
	defer scsm.reentrancyGuard.mu.Unlock()
	
	if scsm.reentrancyGuard.entering[key] {
		scsm.metrics.attacksBlocked++
		return errors.New("reentrancy detected")
	}
	
	scsm.reentrancyGuard.entering[key] = true
	
	// Function should call ReleaseReentrancy when done
	return nil
}

// ReleaseReentrancy releases reentrancy lock
func (scsm *SmartContractSecurityManager) ReleaseReentrancy(contractAddr common.Address, functionSig string) {
	if scsm.reentrancyGuard == nil {
		return
	}
	
	key := fmt.Sprintf("%s:%s", contractAddr.Hex(), functionSig)
	
	scsm.reentrancyGuard.mu.Lock()
	defer scsm.reentrancyGuard.mu.Unlock()
	
	delete(scsm.reentrancyGuard.entering, key)
}

// CheckAccess verifies access control
func (scsm *SmartContractSecurityManager) CheckAccess(contractAddr, callerAddr common.Address, function string) error {
	if scsm.accessController == nil {
		return nil
	}
	
	scsm.accessController.mu.RLock()
	defer scsm.accessController.mu.RUnlock()
	
	// Check if caller has required role
	roles := scsm.accessController.roles[callerAddr]
	permissions := scsm.accessController.permissions[function]
	
	for _, role := range roles {
		for _, perm := range permissions {
			if perm.Operation == function && scsm.hasRole(role, perm.Resource) {
				return nil
			}
		}
	}
	
	scsm.metrics.attacksBlocked++
	return errors.New("access denied")
}

// PauseContract pauses a contract
func (scsm *SmartContractSecurityManager) PauseContract(contractAddr common.Address, pausedBy common.Address, reason string, duration time.Duration) error {
	if scsm.pausable == nil {
		return errors.New("pausable controller not enabled")
	}
	
	scsm.pausable.mu.Lock()
	defer scsm.pausable.mu.Unlock()
	
	scsm.pausable.pausedContracts[contractAddr] = PauseInfo{
		PausedAt:   time.Now(),
		PausedBy:   pausedBy,
		Reason:     reason,
		AutoResume: time.Now().Add(duration),
	}
	
	scsm.metrics.contractsPaused++
	
	scsm.logger.Info("Contract paused",
		zap.String("contract", contractAddr.Hex()),
		zap.String("reason", reason),
		zap.Duration("duration", duration),
	)
	
	return nil
}

// IsContractPaused checks if contract is paused
func (scsm *SmartContractSecurityManager) IsContractPaused(contractAddr common.Address) bool {
	if scsm.pausable == nil {
		return false
	}
	
	scsm.pausable.mu.RLock()
	defer scsm.pausable.mu.RUnlock()
	
	pauseInfo, exists := scsm.pausable.pausedContracts[contractAddr]
	if !exists {
		return false
	}
	
	// Check if auto-resume time has passed
	if time.Now().After(pauseInfo.AutoResume) {
		// Remove from paused list
		go func() {
			scsm.pausable.mu.Lock()
			delete(scsm.pausable.pausedContracts, contractAddr)
			scsm.pausable.mu.Unlock()
		}()
		return false
	}
	
	return true
}

// calculateConfidence calculates confidence score for vulnerability detection
func (scsm *SmartContractSecurityManager) calculateConfidence(vuln Vulnerability, context string) float64 {
	confidence := 0.7 // Base confidence
	
	// Adjust based on context
	if strings.Contains(context, "require") || strings.Contains(context, "assert") {
		confidence -= 0.2 // Might be protected
	}
	
	if strings.Contains(context, "onlyOwner") || strings.Contains(context, "modifier") {
		confidence -= 0.1 // Has access control
	}
	
	return min(1.0, max(0.0, confidence))
}

// calculateRiskScore calculates overall risk score
func (scsm *SmartContractSecurityManager) calculateRiskScore(vulnerabilities []DetectedVulnerability) float64 {
	if len(vulnerabilities) == 0 {
		return 0.0
	}
	
	var totalScore float64
	for _, vuln := range vulnerabilities {
		severityScore := float64(vuln.Vulnerability.Severity+1) * 0.25
		totalScore += severityScore * vuln.Confidence
	}
	
	return min(1.0, totalScore/float64(len(vulnerabilities)))
}

// hasRole checks if role has permission
func (scsm *SmartContractSecurityManager) hasRole(role, resource string) bool {
	// Simplified role check
	return true
}

// Helper functions
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Helper types

// SecurityReport contains analysis results
type SecurityReport struct {
	Timestamp       time.Time
	Vulnerabilities []DetectedVulnerability
	RiskScore       float64
}

// DetectedVulnerability represents a detected vulnerability
type DetectedVulnerability struct {
	Vulnerability Vulnerability
	Location      int
	Context       string
	Confidence    float64
}

// VulnerabilityDatabase stores known vulnerabilities
type VulnerabilityDatabase struct {
	mu              sync.RWMutex
	vulnerabilities map[string]Vulnerability
	signatures      map[string]VulnerabilitySignature
}

// VulnerabilitySignature represents a vulnerability signature
type VulnerabilitySignature struct {
	Hash        string
	Description string
	Severity    VulnerabilitySeverity
}

// TokenBucket implements token bucket rate limiting
type TokenBucket struct {
	tokens    float64
	capacity  float64
	rate      float64
	lastCheck time.Time
	mu        sync.Mutex
}

// ContractAuditLogger logs contract security events
type ContractAuditLogger struct {
	logger *zap.Logger
}

func NewContractAuditLogger(logger *zap.Logger) *ContractAuditLogger {
	return &ContractAuditLogger{logger: logger}
}

func (cal *ContractAuditLogger) LogTransaction(contract common.Address, tx *types.Transaction, receipt *types.Receipt) {
	cal.logger.Info("CONTRACT_AUDIT: Transaction",
		zap.String("contract", contract.Hex()),
		zap.String("tx_hash", tx.Hash().Hex()),
		zap.Uint64("gas_used", receipt.GasUsed),
		zap.Uint("status", receipt.Status),
	)
}

// GasMonitor monitors gas usage
type GasMonitor struct {
	logger    *zap.Logger
	threshold uint64
}

func NewGasMonitor(logger *zap.Logger, threshold uint64) *GasMonitor {
	return &GasMonitor{
		logger:    logger,
		threshold: threshold,
	}
}

// RuntimeMonitor methods

func (rm *RuntimeMonitor) getOrCreateMonitor(addr common.Address) *ContractMonitor {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	
	if monitor, exists := rm.contracts[addr]; exists {
		return monitor
	}
	
	monitor := &ContractMonitor{
		Address:          addr,
		ValueTransferred: big.NewInt(0),
		GasUsage:         make([]uint64, 0, 100),
	}
	
	rm.contracts[addr] = monitor
	return monitor
}

func (rm *RuntimeMonitor) monitorLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	
	for range ticker.C {
		rm.performHealthCheck()
	}
}

func (rm *RuntimeMonitor) performHealthCheck() {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	
	for addr, monitor := range rm.contracts {
		// Check for anomalies
		if len(monitor.SuspiciousActivity) > 10 {
			rm.logger.Warn("High suspicious activity on contract",
				zap.String("address", addr.Hex()),
				zap.Int("count", len(monitor.SuspiciousActivity)),
			)
		}
	}
}

// ContractRateLimiter methods

func (crl *ContractRateLimiter) CheckLimit(contract common.Address, tx *types.Transaction) error {
	crl.mu.Lock()
	defer crl.mu.Unlock()
	
	limit, exists := crl.limits[contract]
	if !exists {
		return nil // No limit set
	}
	
	bucket, exists := crl.buckets[contract]
	if !exists {
		bucket = &TokenBucket{
			capacity: float64(limit.CallsPerMinute),
			rate:     float64(limit.CallsPerMinute) / 60.0,
			tokens:   float64(limit.CallsPerMinute),
			lastCheck: time.Now(),
		}
		crl.buckets[contract] = bucket
	}
	
	// Check if we have tokens
	if !bucket.consume(1.0) {
		return errors.New("rate limit exceeded")
	}
	
	return nil
}

func (tb *TokenBucket) consume(tokens float64) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	
	// Refill tokens
	now := time.Now()
	elapsed := now.Sub(tb.lastCheck).Seconds()
	tb.tokens = min(tb.capacity, tb.tokens+elapsed*tb.rate)
	tb.lastCheck = now
	
	// Check if we have enough tokens
	if tb.tokens >= tokens {
		tb.tokens -= tokens
		return true
	}
	
	return false
}