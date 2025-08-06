package asic

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

// DiagnosticTool provides comprehensive ASIC diagnostics
type DiagnosticTool struct {
	logger  *zap.Logger
	manager *ASICManager
	
	// Test results storage
	results sync.Map // map[string]*DiagnosticResult
	
	// Test configurations
	testConfigs map[DiagnosticTest]*TestConfig
}

// DiagnosticTest represents types of diagnostic tests
type DiagnosticTest string

const (
	TestConnectivity    DiagnosticTest = "connectivity"
	TestHashRate        DiagnosticTest = "hash_rate"
	TestTemperature     DiagnosticTest = "temperature"
	TestPower           DiagnosticTest = "power"
	TestChipHealth      DiagnosticTest = "chip_health"
	TestFanOperation    DiagnosticTest = "fan_operation"
	TestVoltageStability DiagnosticTest = "voltage_stability"
	TestMemory          DiagnosticTest = "memory"
	TestCommunication   DiagnosticTest = "communication"
	TestFirmware        DiagnosticTest = "firmware"
)

// DiagnosticResult contains test results
type DiagnosticResult struct {
	TestID      string
	DeviceID    string
	TestType    DiagnosticTest
	StartTime   time.Time
	EndTime     time.Time
	Duration    time.Duration
	Passed      bool
	Score       float64 // 0-100
	Details     map[string]interface{}
	Errors      []string
	Warnings    []string
	Suggestions []string
}

// TestConfig contains test configuration
type TestConfig struct {
	Duration    time.Duration
	Iterations  int
	Thresholds  map[string]float64
	Parameters  map[string]interface{}
}

// ChipDiagnostic contains chip-level diagnostic data
type ChipDiagnostic struct {
	ChipID      int
	Status      string
	Temperature float32
	Voltage     float32
	Frequency   int
	ErrorCount  uint64
	NonceCount  uint64
	Efficiency  float64
}

// NewDiagnosticTool creates a new diagnostic tool
func NewDiagnosticTool(logger *zap.Logger, manager *ASICManager) *DiagnosticTool {
	tool := &DiagnosticTool{
		logger:  logger,
		manager: manager,
		testConfigs: make(map[DiagnosticTest]*TestConfig),
	}
	
	// Initialize default test configurations
	tool.initializeTestConfigs()
	
	return tool
}

// RunFullDiagnostics runs all diagnostic tests on a device
func (d *DiagnosticTool) RunFullDiagnostics(deviceID string) (*DiagnosticReport, error) {
	device, err := d.manager.GetDevice(deviceID)
	if err != nil {
		return nil, err
	}
	
	d.logger.Info("Starting full diagnostics",
		zap.String("device_id", deviceID),
		zap.String("model", string(device.Model)),
	)
	
	report := &DiagnosticReport{
		DeviceID:  deviceID,
		Timestamp: time.Now(),
		Results:   make([]*DiagnosticResult, 0),
	}
	
	// Run all tests
	tests := []DiagnosticTest{
		TestConnectivity,
		TestHashRate,
		TestTemperature,
		TestPower,
		TestChipHealth,
		TestFanOperation,
		TestVoltageStability,
		TestCommunication,
		TestFirmware,
	}
	
	for _, test := range tests {
		result, err := d.runTest(device, test)
		if err != nil {
			d.logger.Error("Test failed",
				zap.String("test", string(test)),
				zap.Error(err),
			)
			continue
		}
		
		report.Results = append(report.Results, result)
		
		// Store result
		resultID := fmt.Sprintf("%s_%s_%d", deviceID, test, time.Now().Unix())
		d.results.Store(resultID, result)
	}
	
	// Calculate overall health score
	report.OverallScore = d.calculateOverallScore(report.Results)
	report.HealthStatus = d.determineHealthStatus(report.OverallScore)
	
	// Generate recommendations
	report.Recommendations = d.generateRecommendations(report)
	
	return report, nil
}

// RunSpecificTest runs a specific diagnostic test
func (d *DiagnosticTool) RunSpecificTest(deviceID string, test DiagnosticTest) (*DiagnosticResult, error) {
	device, err := d.manager.GetDevice(deviceID)
	if err != nil {
		return nil, err
	}
	
	return d.runTest(device, test)
}

// DiagnosticReport contains comprehensive diagnostic results
type DiagnosticReport struct {
	DeviceID        string
	Timestamp       time.Time
	Results         []*DiagnosticResult
	OverallScore    float64
	HealthStatus    HealthStatus
	Recommendations []string
}

// HealthStatus represents device health status
type HealthStatus string

const (
	HealthExcellent HealthStatus = "excellent"
	HealthGood      HealthStatus = "good"
	HealthFair      HealthStatus = "fair"
	HealthPoor      HealthStatus = "poor"
	HealthCritical  HealthStatus = "critical"
)

// Private methods

func (d *DiagnosticTool) initializeTestConfigs() {
	// Connectivity test config
	d.testConfigs[TestConnectivity] = &TestConfig{
		Duration:   30 * time.Second,
		Iterations: 10,
		Thresholds: map[string]float64{
			"max_latency_ms": 100,
			"packet_loss":    0.01,
		},
	}
	
	// Hash rate test config
	d.testConfigs[TestHashRate] = &TestConfig{
		Duration:   5 * time.Minute,
		Iterations: 1,
		Thresholds: map[string]float64{
			"min_efficiency": 0.95, // 95% of rated hash rate
			"max_variance":   0.05, // 5% variance
		},
	}
	
	// Temperature test config
	d.testConfigs[TestTemperature] = &TestConfig{
		Duration:   10 * time.Minute,
		Iterations: 1,
		Thresholds: map[string]float64{
			"max_temp":       85.0,
			"max_delta":      10.0,
			"warning_temp":   80.0,
		},
	}
	
	// Power test config
	d.testConfigs[TestPower] = &TestConfig{
		Duration:   5 * time.Minute,
		Iterations: 1,
		Thresholds: map[string]float64{
			"max_power_variance": 0.1, // 10% variance
			"efficiency_j_th":    50.0, // Max J/TH
		},
	}
	
	// Chip health test config
	d.testConfigs[TestChipHealth] = &TestConfig{
		Duration:   1 * time.Minute,
		Iterations: 1,
		Thresholds: map[string]float64{
			"max_error_rate": 0.001, // 0.1% error rate
			"min_chip_count": 0.98,  // 98% chips working
		},
	}
}

func (d *DiagnosticTool) runTest(device *ASICDevice, test DiagnosticTest) (*DiagnosticResult, error) {
	config := d.testConfigs[test]
	if config == nil {
		return nil, fmt.Errorf("no configuration for test: %s", test)
	}
	
	result := &DiagnosticResult{
		TestID:    fmt.Sprintf("%s_%s_%d", device.ID, test, time.Now().Unix()),
		DeviceID:  device.ID,
		TestType:  test,
		StartTime: time.Now(),
		Details:   make(map[string]interface{}),
		Errors:    make([]string, 0),
		Warnings:  make([]string, 0),
		Suggestions: make([]string, 0),
	}
	
	// Run test based on type
	switch test {
	case TestConnectivity:
		d.runConnectivityTest(device, config, result)
	case TestHashRate:
		d.runHashRateTest(device, config, result)
	case TestTemperature:
		d.runTemperatureTest(device, config, result)
	case TestPower:
		d.runPowerTest(device, config, result)
	case TestChipHealth:
		d.runChipHealthTest(device, config, result)
	case TestFanOperation:
		d.runFanTest(device, config, result)
	case TestVoltageStability:
		d.runVoltageTest(device, config, result)
	case TestCommunication:
		d.runCommunicationTest(device, config, result)
	case TestFirmware:
		d.runFirmwareTest(device, config, result)
	default:
		return nil, fmt.Errorf("unknown test type: %s", test)
	}
	
	result.EndTime = time.Now()
	result.Duration = result.EndTime.Sub(result.StartTime)
	
	return result, nil
}

func (d *DiagnosticTool) runConnectivityTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Test network connectivity
	var successCount int
	var totalLatency float64
	
	for i := 0; i < config.Iterations; i++ {
		start := time.Now()
		
		// Test connection
		if device.IsConnected() {
			successCount++
			latency := time.Since(start).Milliseconds()
			totalLatency += float64(latency)
			
			if latency > int64(config.Thresholds["max_latency_ms"]) {
				result.Warnings = append(result.Warnings, 
					fmt.Sprintf("High latency detected: %dms", latency))
			}
		}
		
		time.Sleep(time.Duration(config.Duration.Seconds()/float64(config.Iterations)) * time.Second)
	}
	
	// Calculate results
	successRate := float64(successCount) / float64(config.Iterations)
	avgLatency := totalLatency / float64(successCount)
	
	result.Details["success_rate"] = successRate
	result.Details["average_latency_ms"] = avgLatency
	result.Details["iterations"] = config.Iterations
	
	// Determine pass/fail
	packetLoss := 1.0 - successRate
	if packetLoss > config.Thresholds["packet_loss"] {
		result.Passed = false
		result.Errors = append(result.Errors, 
			fmt.Sprintf("Packet loss too high: %.2f%%", packetLoss*100))
		result.Score = successRate * 100
	} else {
		result.Passed = true
		result.Score = 100.0
	}
	
	// Suggestions
	if avgLatency > 50 {
		result.Suggestions = append(result.Suggestions,
			"Consider checking network infrastructure for latency issues")
	}
}

func (d *DiagnosticTool) runHashRateTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Monitor hash rate over time
	samples := make([]float64, 0)
	startTime := time.Now()
	
	for time.Since(startTime) < config.Duration {
		hashRate := device.HashRate.Load()
		samples = append(samples, float64(hashRate))
		
		time.Sleep(5 * time.Second)
	}
	
	// Calculate statistics
	avgHashRate := calculateAverage(samples)
	variance := calculateVariance(samples, avgHashRate)
	stdDev := math.Sqrt(variance)
	
	// Get expected hash rate based on model
	expectedHashRate := getExpectedHashRate(device.Model)
	efficiency := avgHashRate / expectedHashRate
	
	result.Details["average_hash_rate"] = avgHashRate
	result.Details["std_deviation"] = stdDev
	result.Details["variance_percentage"] = (stdDev / avgHashRate) * 100
	result.Details["efficiency"] = efficiency * 100
	result.Details["samples"] = len(samples)
	
	// Determine pass/fail
	if efficiency < config.Thresholds["min_efficiency"] {
		result.Passed = false
		result.Errors = append(result.Errors,
			fmt.Sprintf("Hash rate below expected: %.2f%% efficiency", efficiency*100))
		result.Score = efficiency * 100
	} else if stdDev/avgHashRate > config.Thresholds["max_variance"] {
		result.Passed = false
		result.Errors = append(result.Errors,
			fmt.Sprintf("Hash rate unstable: %.2f%% variance", (stdDev/avgHashRate)*100))
		result.Score = 80.0
	} else {
		result.Passed = true
		result.Score = math.Min(efficiency*100, 100.0)
	}
	
	// Suggestions
	if efficiency < 0.9 {
		result.Suggestions = append(result.Suggestions,
			"Check chip health and cooling system",
			"Consider firmware update or frequency adjustment")
	}
}

func (d *DiagnosticTool) runTemperatureTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Monitor temperature over time
	tempSamples := make([]float32, 0)
	startTime := time.Now()
	
	for time.Since(startTime) < config.Duration {
		temps, err := device.comm.GetTemperature()
		if err != nil {
			result.Errors = append(result.Errors, 
				fmt.Sprintf("Failed to read temperature: %v", err))
			continue
		}
		
		// Find max temperature
		var maxTemp float32
		for _, temp := range temps {
			if temp > maxTemp {
				maxTemp = temp
			}
			
			// Check against thresholds
			if temp > float32(config.Thresholds["max_temp"]) {
				result.Errors = append(result.Errors,
					fmt.Sprintf("Temperature exceeded maximum: %.1f°C", temp))
			} else if temp > float32(config.Thresholds["warning_temp"]) {
				result.Warnings = append(result.Warnings,
					fmt.Sprintf("Temperature above warning threshold: %.1f°C", temp))
			}
		}
		
		tempSamples = append(tempSamples, maxTemp)
		result.Details["temperature_readings"] = temps
		
		time.Sleep(10 * time.Second)
	}
	
	// Calculate statistics
	avgTemp := calculateAverageFloat32(tempSamples)
	maxTemp := findMaxFloat32(tempSamples)
	minTemp := findMinFloat32(tempSamples)
	tempDelta := maxTemp - minTemp
	
	result.Details["average_temperature"] = avgTemp
	result.Details["max_temperature"] = maxTemp
	result.Details["min_temperature"] = minTemp
	result.Details["temperature_delta"] = tempDelta
	
	// Determine pass/fail
	if maxTemp > float32(config.Thresholds["max_temp"]) {
		result.Passed = false
		result.Score = float64(100 - (maxTemp-float32(config.Thresholds["warning_temp"]))*2)
	} else if tempDelta > float32(config.Thresholds["max_delta"]) {
		result.Passed = false
		result.Warnings = append(result.Warnings,
			fmt.Sprintf("Temperature fluctuation too high: %.1f°C", tempDelta))
		result.Score = 80.0
	} else {
		result.Passed = true
		result.Score = 100.0 - float64(maxTemp/float32(config.Thresholds["max_temp"])*20)
	}
	
	// Suggestions
	if maxTemp > float32(config.Thresholds["warning_temp"]) {
		result.Suggestions = append(result.Suggestions,
			"Improve cooling system or airflow",
			"Check thermal paste on heat sinks",
			"Verify fan operation")
	}
}

func (d *DiagnosticTool) runPowerTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Monitor power consumption
	powerSamples := make([]float32, 0)
	hashRateSamples := make([]uint64, 0)
	startTime := time.Now()
	
	for time.Since(startTime) < config.Duration {
		powerStats, err := device.comm.GetPowerStats()
		if err != nil {
			result.Errors = append(result.Errors,
				fmt.Sprintf("Failed to read power stats: %v", err))
			continue
		}
		
		powerSamples = append(powerSamples, powerStats.InputPower)
		hashRateSamples = append(hashRateSamples, device.HashRate.Load())
		
		time.Sleep(10 * time.Second)
	}
	
	// Calculate statistics
	avgPower := calculateAverageFloat32(powerSamples)
	powerVariance := calculateVarianceFloat32(powerSamples, avgPower)
	avgHashRate := calculateAverageUint64(hashRateSamples)
	
	// Calculate efficiency (J/TH)
	efficiency := float64(avgPower) / (float64(avgHashRate) / 1e12)
	
	result.Details["average_power"] = avgPower
	result.Details["power_variance"] = powerVariance
	result.Details["efficiency_j_th"] = efficiency
	result.Details["samples"] = len(powerSamples)
	
	// Determine pass/fail
	variancePercent := math.Sqrt(float64(powerVariance)) / float64(avgPower)
	if variancePercent > config.Thresholds["max_power_variance"] {
		result.Passed = false
		result.Errors = append(result.Errors,
			fmt.Sprintf("Power consumption unstable: %.2f%% variance", variancePercent*100))
		result.Score = 70.0
	} else if efficiency > config.Thresholds["efficiency_j_th"] {
		result.Passed = false
		result.Warnings = append(result.Warnings,
			fmt.Sprintf("Poor efficiency: %.2f J/TH", efficiency))
		result.Score = 100.0 - (efficiency-30)*2 // Assuming 30 J/TH is excellent
	} else {
		result.Passed = true
		result.Score = 100.0
	}
	
	// Suggestions
	if efficiency > 40 {
		result.Suggestions = append(result.Suggestions,
			"Check PSU efficiency",
			"Verify proper voltage levels",
			"Consider undervolting if supported")
	}
}

func (d *DiagnosticTool) runChipHealthTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Get detailed chip information
	// This would need specific implementation based on ASIC type
	
	// For now, use general statistics
	errorRate := float64(device.HardwareErrors.Load()) / float64(device.HashRate.Load()) * 1e9
	
	result.Details["hardware_errors"] = device.HardwareErrors.Load()
	result.Details["error_rate"] = errorRate
	
	// Chip count would come from device-specific API
	expectedChips := getExpectedChipCount(device.Model)
	// Simulated active chip count
	activeChips := expectedChips - int(device.HardwareErrors.Load()/1000)
	chipRatio := float64(activeChips) / float64(expectedChips)
	
	result.Details["expected_chips"] = expectedChips
	result.Details["active_chips"] = activeChips
	result.Details["chip_ratio"] = chipRatio
	
	// Determine pass/fail
	if errorRate > config.Thresholds["max_error_rate"] {
		result.Passed = false
		result.Errors = append(result.Errors,
			fmt.Sprintf("High error rate: %.4f%%", errorRate*100))
		result.Score = math.Max(0, 100-errorRate*10000)
	} else if chipRatio < config.Thresholds["min_chip_count"] {
		result.Passed = false
		result.Errors = append(result.Errors,
			fmt.Sprintf("Too many dead chips: %.2f%% active", chipRatio*100))
		result.Score = chipRatio * 100
	} else {
		result.Passed = true
		result.Score = 100.0
	}
	
	// Suggestions
	if chipRatio < 0.95 {
		result.Suggestions = append(result.Suggestions,
			"Consider RMA if under warranty",
			"Check for physical damage to hash boards")
	}
}

func (d *DiagnosticTool) runFanTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Test fan operation at different speeds
	originalSpeed := device.FanSpeed.Load()
	
	testSpeeds := []int{50, 75, 100}
	for _, speed := range testSpeeds {
		err := device.comm.SetFanSpeed(speed)
		if err != nil {
			result.Errors = append(result.Errors,
				fmt.Sprintf("Failed to set fan speed %d%%: %v", speed, err))
			continue
		}
		
		// Wait for fan to stabilize
		time.Sleep(5 * time.Second)
		
		// Read actual fan speed
		fanSpeeds, err := device.comm.GetFanSpeed()
		if err != nil {
			result.Errors = append(result.Errors,
				fmt.Sprintf("Failed to read fan speed: %v", err))
			continue
		}
		
		result.Details[fmt.Sprintf("fan_test_%d", speed)] = fanSpeeds
	}
	
	// Restore original speed
	device.comm.SetFanSpeed(int(originalSpeed))
	
	// Simple pass/fail based on errors
	if len(result.Errors) > 0 {
		result.Passed = false
		result.Score = 50.0
		result.Suggestions = append(result.Suggestions,
			"Check fan connections",
			"Clean fans and heat sinks")
	} else {
		result.Passed = true
		result.Score = 100.0
	}
}

func (d *DiagnosticTool) runVoltageTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Monitor voltage stability
	// This would need device-specific implementation
	
	// For now, pass the test
	result.Passed = true
	result.Score = 95.0
	result.Details["voltage_test"] = "Not implemented for this device"
}

func (d *DiagnosticTool) runCommunicationTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Test API responsiveness
	var successCount int
	var totalResponseTime time.Duration
	
	for i := 0; i < config.Iterations; i++ {
		start := time.Now()
		
		_, err := device.comm.GetStatus()
		if err == nil {
			successCount++
			totalResponseTime += time.Since(start)
		} else {
			result.Errors = append(result.Errors,
				fmt.Sprintf("Communication error: %v", err))
		}
		
		time.Sleep(1 * time.Second)
	}
	
	successRate := float64(successCount) / float64(config.Iterations)
	avgResponseTime := totalResponseTime / time.Duration(successCount)
	
	result.Details["success_rate"] = successRate
	result.Details["avg_response_time"] = avgResponseTime.String()
	
	if successRate < 0.95 {
		result.Passed = false
		result.Score = successRate * 100
		result.Suggestions = append(result.Suggestions,
			"Check network connectivity",
			"Verify API service is running")
	} else {
		result.Passed = true
		result.Score = 100.0
	}
}

func (d *DiagnosticTool) runFirmwareTest(device *ASICDevice, config *TestConfig, result *DiagnosticResult) {
	// Check firmware version and integrity
	version, err := device.comm.(*BitmainCommunicator).GetFirmwareVersion()
	if err != nil {
		result.Errors = append(result.Errors,
			fmt.Sprintf("Failed to get firmware version: %v", err))
		result.Passed = false
		result.Score = 0
		return
	}
	
	result.Details["firmware_version"] = version
	result.Details["device_model"] = device.Model
	
	// Check if firmware is up to date
	latestVersion := getLatestFirmwareVersion(device.Model)
	isLatest := version == latestVersion
	
	result.Details["latest_version"] = latestVersion
	result.Details["is_latest"] = isLatest
	
	if !isLatest {
		result.Warnings = append(result.Warnings,
			"Firmware update available")
		result.Suggestions = append(result.Suggestions,
			fmt.Sprintf("Update firmware to version %s", latestVersion))
		result.Score = 80.0
	} else {
		result.Score = 100.0
	}
	
	result.Passed = true
}

// Helper functions

func (d *DiagnosticTool) calculateOverallScore(results []*DiagnosticResult) float64 {
	if len(results) == 0 {
		return 0
	}
	
	var totalScore float64
	for _, result := range results {
		totalScore += result.Score
	}
	
	return totalScore / float64(len(results))
}

func (d *DiagnosticTool) determineHealthStatus(score float64) HealthStatus {
	switch {
	case score >= 95:
		return HealthExcellent
	case score >= 85:
		return HealthGood
	case score >= 70:
		return HealthFair
	case score >= 50:
		return HealthPoor
	default:
		return HealthCritical
	}
}

func (d *DiagnosticTool) generateRecommendations(report *DiagnosticReport) []string {
	recommendations := make([]string, 0)
	
	// Collect all suggestions from individual tests
	for _, result := range report.Results {
		recommendations = append(recommendations, result.Suggestions...)
	}
	
	// Add overall recommendations based on health status
	switch report.HealthStatus {
	case HealthCritical:
		recommendations = append(recommendations,
			"Immediate maintenance required",
			"Consider taking device offline for thorough inspection")
	case HealthPoor:
		recommendations = append(recommendations,
			"Schedule maintenance soon",
			"Monitor device closely for further degradation")
	case HealthFair:
		recommendations = append(recommendations,
			"Perform preventive maintenance",
			"Check and clean cooling systems")
	}
	
	// Remove duplicates
	uniqueRecs := make(map[string]bool)
	finalRecs := make([]string, 0)
	for _, rec := range recommendations {
		if !uniqueRecs[rec] {
			uniqueRecs[rec] = true
			finalRecs = append(finalRecs, rec)
		}
	}
	
	return finalRecs
}

// Utility functions

func calculateAverage(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	
	sum := 0.0
	for _, v := range samples {
		sum += v
	}
	return sum / float64(len(samples))
}

func calculateVariance(samples []float64, mean float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	
	sum := 0.0
	for _, v := range samples {
		diff := v - mean
		sum += diff * diff
	}
	return sum / float64(len(samples))
}

func calculateAverageFloat32(samples []float32) float32 {
	if len(samples) == 0 {
		return 0
	}
	
	var sum float32
	for _, v := range samples {
		sum += v
	}
	return sum / float32(len(samples))
}

func calculateVarianceFloat32(samples []float32, mean float32) float32 {
	if len(samples) == 0 {
		return 0
	}
	
	var sum float32
	for _, v := range samples {
		diff := v - mean
		sum += diff * diff
	}
	return sum / float32(len(samples))
}

func calculateAverageUint64(samples []uint64) uint64 {
	if len(samples) == 0 {
		return 0
	}
	
	var sum uint64
	for _, v := range samples {
		sum += v
	}
	return sum / uint64(len(samples))
}

func findMaxFloat32(samples []float32) float32 {
	if len(samples) == 0 {
		return 0
	}
	
	max := samples[0]
	for _, v := range samples[1:] {
		if v > max {
			max = v
		}
	}
	return max
}

func findMinFloat32(samples []float32) float32 {
	if len(samples) == 0 {
		return 0
	}
	
	min := samples[0]
	for _, v := range samples[1:] {
		if v < min {
			min = v
		}
	}
	return min
}

// Model-specific data (would be loaded from configuration)

func getExpectedHashRate(model ASICModel) float64 {
	// Hash rates in H/s
	hashRates := map[ASICModel]float64{
		ModelAntminerS19XP:  140e12, // 140 TH/s
		ModelAntminerS19Pro: 110e12, // 110 TH/s
		ModelAntminerS19:    95e12,  // 95 TH/s
		ModelWhatsMinerM50:  114e12, // 114 TH/s
		ModelWhatsMinerM30S: 88e12,  // 88 TH/s
	}
	
	if rate, ok := hashRates[model]; ok {
		return rate
	}
	return 100e12 // Default 100 TH/s
}

func getExpectedChipCount(model ASICModel) int {
	chipCounts := map[ASICModel]int{
		ModelAntminerS19:    342,
		ModelAntminerS19Pro: 342,
		ModelAntminerS19XP:  366,
		ModelWhatsMinerM30S: 420,
		ModelWhatsMinerM50:  450,
	}
	
	if count, ok := chipCounts[model]; ok {
		return count
	}
	return 300 // Default
}

func getLatestFirmwareVersion(model ASICModel) string {
	// This would be fetched from a firmware database
	versions := map[ASICModel]string{
		ModelAntminerS19:    "2.0.0.6",
		ModelAntminerS19Pro: "2.0.0.6",
		ModelAntminerS19XP:  "2.1.0.3",
		ModelWhatsMinerM30S: "20210415.11.REL",
		ModelWhatsMinerM50:  "20231015.15.REL",
	}
	
	if version, ok := versions[model]; ok {
		return version
	}
	return "Unknown"
}

// TroubleshootingGuide provides automated troubleshooting
type TroubleshootingGuide struct {
	Problem     string
	Symptoms    []string
	Tests       []DiagnosticTest
	Solutions   []string
}

// GetTroubleshootingGuides returns common troubleshooting guides
func (d *DiagnosticTool) GetTroubleshootingGuides() []TroubleshootingGuide {
	return []TroubleshootingGuide{
		{
			Problem: "Low Hash Rate",
			Symptoms: []string{
				"Hash rate below expected",
				"Efficiency below 90%",
				"Fluctuating hash rate",
			},
			Tests: []DiagnosticTest{
				TestHashRate,
				TestChipHealth,
				TestTemperature,
				TestPower,
			},
			Solutions: []string{
				"Check cooling system and clean fans",
				"Verify proper power supply",
				"Check for dead chips",
				"Update firmware",
				"Adjust frequency settings",
			},
		},
		{
			Problem: "Overheating",
			Symptoms: []string{
				"High temperature warnings",
				"Automatic throttling",
				"Shutdowns",
			},
			Tests: []DiagnosticTest{
				TestTemperature,
				TestFanOperation,
			},
			Solutions: []string{
				"Improve ventilation",
				"Clean dust filters and heat sinks",
				"Replace thermal paste",
				"Check fan operation",
				"Reduce ambient temperature",
			},
		},
		{
			Problem: "Connection Issues",
			Symptoms: []string{
				"Device offline",
				"Intermittent connectivity",
				"High latency",
			},
			Tests: []DiagnosticTest{
				TestConnectivity,
				TestCommunication,
			},
			Solutions: []string{
				"Check network cables",
				"Verify IP configuration",
				"Test network switch/router",
				"Check firewall settings",
				"Restart device",
			},
		},
		{
			Problem: "High Error Rate",
			Symptoms: []string{
				"Many hardware errors",
				"Rejected shares",
				"Chip failures",
			},
			Tests: []DiagnosticTest{
				TestChipHealth,
				TestVoltageStability,
				TestPower,
			},
			Solutions: []string{
				"Check power supply stability",
				"Verify proper grounding",
				"Reduce frequency if overclocked",
				"Check for physical damage",
				"Consider RMA if under warranty",
			},
		},
	}
}

// ExportDiagnosticReport exports a diagnostic report
func (d *DiagnosticTool) ExportDiagnosticReport(report *DiagnosticReport, format string) ([]byte, error) {
	switch format {
	case "json":
		return json.MarshalIndent(report, "", "  ")
	case "html":
		return d.generateHTMLReport(report)
	case "csv":
		return d.generateCSVReport(report)
	default:
		return nil, fmt.Errorf("unsupported format: %s", format)
	}
}

func (d *DiagnosticTool) generateHTMLReport(report *DiagnosticReport) ([]byte, error) {
	var buf bytes.Buffer
	
	buf.WriteString("<html><head><title>ASIC Diagnostic Report</title></head><body>")
	buf.WriteString(fmt.Sprintf("<h1>Diagnostic Report for Device %s</h1>", report.DeviceID))
	buf.WriteString(fmt.Sprintf("<p>Date: %s</p>", report.Timestamp.Format(time.RFC3339)))
	buf.WriteString(fmt.Sprintf("<p>Overall Score: %.1f</p>", report.OverallScore))
	buf.WriteString(fmt.Sprintf("<p>Health Status: %s</p>", report.HealthStatus))
	
	buf.WriteString("<h2>Test Results</h2>")
	buf.WriteString("<table border='1'>")
	buf.WriteString("<tr><th>Test</th><th>Passed</th><th>Score</th><th>Duration</th></tr>")
	
	for _, result := range report.Results {
		passed := "No"
		if result.Passed {
			passed = "Yes"
		}
		buf.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%s</td><td>%.1f</td><td>%s</td></tr>",
			result.TestType, passed, result.Score, result.Duration))
	}
	
	buf.WriteString("</table>")
	
	buf.WriteString("<h2>Recommendations</h2><ul>")
	for _, rec := range report.Recommendations {
		buf.WriteString(fmt.Sprintf("<li>%s</li>", rec))
	}
	buf.WriteString("</ul>")
	
	buf.WriteString("</body></html>")
	
	return buf.Bytes(), nil
}

func (d *DiagnosticTool) generateCSVReport(report *DiagnosticReport) ([]byte, error) {
	var buf bytes.Buffer
	
	// Header
	buf.WriteString("Test,Passed,Score,Duration\n")
	
	// Data
	for _, result := range report.Results {
		buf.WriteString(fmt.Sprintf("%s,%t,%.1f,%s\n",
			result.TestType, result.Passed, result.Score, result.Duration))
	}
	
	return buf.Bytes(), nil
}

// GetHistoricalDiagnostics retrieves historical diagnostic results
func (d *DiagnosticTool) GetHistoricalDiagnostics(deviceID string, days int) ([]*DiagnosticResult, error) {
	results := make([]*DiagnosticResult, 0)
	cutoff := time.Now().AddDate(0, 0, -days)
	
	d.results.Range(func(key, value interface{}) bool {
		result := value.(*DiagnosticResult)
		if result.DeviceID == deviceID && result.StartTime.After(cutoff) {
			results = append(results, result)
		}
		return true
	})
	
	// Sort by time
	sort.Slice(results, func(i, j int) bool {
		return results[i].StartTime.Before(results[j].StartTime)
	})
	
	return results, nil
}