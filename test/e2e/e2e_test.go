package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/otedama/otedama/internal/testing"
	"github.com/stretchr/testify/suite"
)

// E2ETestSuite provides end-to-end testing
type E2ETestSuite struct {
	testing.TestSuite
	
	// Test environment
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// SetupSuite sets up E2E test environment
func (e2e *E2ETestSuite) SetupSuite() {
	e2e.TestSuite.SetupSuite()
	
	// Get test environment config
	e2e.baseURL = os.Getenv("E2E_BASE_URL")
	if e2e.baseURL == "" {
		e2e.baseURL = "http://localhost:8080"
	}
	
	e2e.apiKey = os.Getenv("E2E_API_KEY")
	if e2e.apiKey == "" {
		e2e.apiKey = "test-api-key"
	}
	
	// Create HTTP client
	e2e.httpClient = &http.Client{
		Timeout: 30 * time.Second,
	}
	
	// Wait for service to be ready
	e2e.waitForService()
}

// waitForService waits for service to be ready
func (e2e *E2ETestSuite) waitForService() {
	e2e.Framework.AssertEventually(func() bool {
		resp, err := e2e.httpClient.Get(e2e.baseURL + "/health")
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}, 30*time.Second, "Service not ready")
}

// TestCompleteUserJourney tests complete user journey
func (e2e *E2ETestSuite) TestCompleteUserJourney() {
	// 1. Register user
	userID := e2e.registerUser()
	
	// 2. Create wallet
	walletID := e2e.createWallet(userID)
	
	// 3. Create worker
	workerID := e2e.createWorker(userID)
	
	// 4. Start mining
	e2e.startMining(workerID)
	
	// 5. Submit shares
	e2e.submitShares(workerID, 100)
	
	// 6. Check statistics
	stats := e2e.getStatistics(userID)
	e2e.Require().Greater(stats.SharesSubmitted, int64(0))
	
	// 7. Check earnings
	earnings := e2e.getEarnings(userID)
	e2e.Require().GreaterOrEqual(earnings.PendingBalance, 0.0)
	
	// 8. Request payout
	if earnings.PendingBalance >= 0.001 {
		e2e.requestPayout(userID, walletID)
	}
}

// TestPoolFailover tests pool failover functionality
func (e2e *E2ETestSuite) TestPoolFailover() {
	// 1. Connect to primary pool
	primaryConn := e2e.connectToPool("primary.pool.otedama.com:3333")
	defer primaryConn.Close()
	
	// 2. Submit shares to primary
	e2e.submitSharesViaStratum(primaryConn, 10)
	
	// 3. Simulate primary pool failure
	primaryConn.SimulateFailure()
	
	// 4. Verify failover to backup pool
	e2e.Framework.AssertEventually(func() bool {
		status := e2e.getMinerStatus()
		return status.CurrentPool == "backup.pool.otedama.com:3334"
	}, 30*time.Second, "Failover did not occur")
	
	// 5. Verify mining continues
	backupConn := e2e.connectToPool("backup.pool.otedama.com:3334")
	defer backupConn.Close()
	
	e2e.submitSharesViaStratum(backupConn, 10)
}

// TestAPIRateLimiting tests API rate limiting
func (e2e *E2ETestSuite) TestAPIRateLimiting() {
	// Make rapid requests
	endpoint := "/api/v1/stats"
	
	successCount := 0
	rateLimitedCount := 0
	
	for i := 0; i < 150; i++ {
		resp, err := e2e.makeAPIRequest("GET", endpoint, nil)
		e2e.Require().NoError(err)
		
		switch resp.StatusCode {
		case http.StatusOK:
			successCount++
		case http.StatusTooManyRequests:
			rateLimitedCount++
		default:
			e2e.T().Fatalf("Unexpected status code: %d", resp.StatusCode)
		}
		
		resp.Body.Close()
	}
	
	// Verify rate limiting kicked in
	e2e.Require().Greater(rateLimitedCount, 0, "Rate limiting not enforced")
	e2e.T().Logf("Successful requests: %d, Rate limited: %d", successCount, rateLimitedCount)
	
	// Wait for rate limit to reset
	time.Sleep(1 * time.Minute)
	
	// Verify can make requests again
	resp, err := e2e.makeAPIRequest("GET", endpoint, nil)
	e2e.Require().NoError(err)
	e2e.Require().Equal(http.StatusOK, resp.StatusCode)
	resp.Body.Close()
}

// TestWebSocketConnection tests WebSocket functionality
func (e2e *E2ETestSuite) TestWebSocketConnection() {
	// 1. Connect via WebSocket
	ws := e2e.connectWebSocket()
	defer ws.Close()
	
	// 2. Subscribe to updates
	e2e.sendWSMessage(ws, map[string]interface{}{
		"type": "subscribe",
		"channels": []string{"stats", "shares"},
	})
	
	// 3. Submit share via HTTP
	workerID := e2e.createWorker("test_user")
	e2e.submitShares(workerID, 1)
	
	// 4. Verify WebSocket notification
	msg := e2e.receiveWSMessage(ws)
	e2e.Require().Equal("share_accepted", msg["type"])
	e2e.Require().Equal(workerID, msg["worker_id"])
}

// TestSecurityHeaders tests security headers
func (e2e *E2ETestSuite) TestSecurityHeaders() {
	resp, err := e2e.makeAPIRequest("GET", "/api/v1/stats", nil)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	// Check security headers
	headers := map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":          "DENY",
		"X-XSS-Protection":         "1; mode=block",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
		"Content-Security-Policy":   "default-src 'self'",
	}
	
	for header, expected := range headers {
		actual := resp.Header.Get(header)
		e2e.Require().NotEmpty(actual, "Missing header: %s", header)
		e2e.Require().Contains(actual, expected, "Invalid header value for %s", header)
	}
}

// TestDataIntegrity tests data integrity across operations
func (e2e *E2ETestSuite) TestDataIntegrity() {
	userID := e2e.registerUser()
	
	// Track initial state
	initialStats := e2e.getStatistics(userID)
	initialEarnings := e2e.getEarnings(userID)
	
	// Perform operations
	workerID := e2e.createWorker(userID)
	shareCount := 50
	e2e.submitShares(workerID, shareCount)
	
	// Wait for processing
	time.Sleep(5 * time.Second)
	
	// Verify data consistency
	finalStats := e2e.getStatistics(userID)
	finalEarnings := e2e.getEarnings(userID)
	
	// Shares should increase by exact amount
	sharesDiff := finalStats.SharesSubmitted - initialStats.SharesSubmitted
	e2e.Require().Equal(int64(shareCount), sharesDiff)
	
	// Earnings should increase
	e2e.Require().Greater(finalEarnings.TotalEarned, initialEarnings.TotalEarned)
	
	// Verify audit trail
	auditLogs := e2e.getAuditLogs(userID)
	e2e.Require().NotEmpty(auditLogs)
}

// Helper methods

func (e2e *E2ETestSuite) registerUser() string {
	data := map[string]interface{}{
		"username": fmt.Sprintf("test_user_%d", time.Now().Unix()),
		"email":    fmt.Sprintf("test_%d@example.com", time.Now().Unix()),
		"password": "TestPassword123!",
	}
	
	resp, err := e2e.makeAPIRequest("POST", "/api/v1/auth/register", data)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	e2e.Require().Equal(http.StatusCreated, resp.StatusCode)
	
	var result map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&result)
	e2e.Require().NoError(err)
	
	return result["user_id"].(string)
}

func (e2e *E2ETestSuite) createWallet(userID string) string {
	data := map[string]interface{}{
		"user_id": userID,
		"type":    "ethereum",
	}
	
	resp, err := e2e.makeAPIRequest("POST", "/api/v1/wallets", data)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	e2e.Require().Equal(http.StatusCreated, resp.StatusCode)
	
	var result map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&result)
	e2e.Require().NoError(err)
	
	return result["wallet_id"].(string)
}

func (e2e *E2ETestSuite) createWorker(userID string) string {
	data := map[string]interface{}{
		"user_id": userID,
		"name":    fmt.Sprintf("worker_%d", time.Now().Unix()),
	}
	
	resp, err := e2e.makeAPIRequest("POST", "/api/v1/workers", data)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	e2e.Require().Equal(http.StatusCreated, resp.StatusCode)
	
	var result map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&result)
	e2e.Require().NoError(err)
	
	return result["worker_id"].(string)
}

func (e2e *E2ETestSuite) startMining(workerID string) {
	data := map[string]interface{}{
		"worker_id": workerID,
		"algorithm": "sha256",
	}
	
	resp, err := e2e.makeAPIRequest("POST", "/api/v1/mining/start", data)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	e2e.Require().Equal(http.StatusOK, resp.StatusCode)
}

func (e2e *E2ETestSuite) submitShares(workerID string, count int) {
	for i := 0; i < count; i++ {
		data := map[string]interface{}{
			"worker_id":  workerID,
			"job_id":     fmt.Sprintf("job_%d", i),
			"nonce":      i,
			"hash":       fmt.Sprintf("0x%064x", i),
			"difficulty": 1000000,
		}
		
		resp, err := e2e.makeAPIRequest("POST", "/api/v1/shares/submit", data)
		e2e.Require().NoError(err)
		resp.Body.Close()
		
		e2e.Require().Equal(http.StatusOK, resp.StatusCode)
		
		// Small delay to avoid overwhelming
		time.Sleep(10 * time.Millisecond)
	}
}

func (e2e *E2ETestSuite) getStatistics(userID string) *UserStatistics {
	resp, err := e2e.makeAPIRequest("GET", fmt.Sprintf("/api/v1/users/%s/stats", userID), nil)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	e2e.Require().Equal(http.StatusOK, resp.StatusCode)
	
	var stats UserStatistics
	err = json.NewDecoder(resp.Body).Decode(&stats)
	e2e.Require().NoError(err)
	
	return &stats
}

func (e2e *E2ETestSuite) getEarnings(userID string) *UserEarnings {
	resp, err := e2e.makeAPIRequest("GET", fmt.Sprintf("/api/v1/users/%s/earnings", userID), nil)
	e2e.Require().NoError(err)
	defer resp.Body.Close()
	
	e2e.Require().Equal(http.StatusOK, resp.StatusCode)
	
	var earnings UserEarnings
	err = json.NewDecoder(resp.Body).Decode(&earnings)
	e2e.Require().NoError(err)
	
	return &earnings
}

func (e2e *E2ETestSuite) makeAPIRequest(method, path string, data interface{}) (*http.Response, error) {
	url := e2e.baseURL + path
	
	var body io.Reader
	if data != nil {
		jsonData, err := json.Marshal(data)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(jsonData)
	}
	
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Authorization", "Bearer "+e2e.apiKey)
	req.Header.Set("Content-Type", "application/json")
	
	return e2e.httpClient.Do(req)
}

// Test data structures

type UserStatistics struct {
	SharesSubmitted int64   `json:"shares_submitted"`
	SharesAccepted  int64   `json:"shares_accepted"`
	SharesRejected  int64   `json:"shares_rejected"`
	HashRate        float64 `json:"hash_rate"`
}

type UserEarnings struct {
	PendingBalance float64 `json:"pending_balance"`
	TotalEarned    float64 `json:"total_earned"`
	TotalPaid      float64 `json:"total_paid"`
}

// Additional helper methods would be implemented...

// Run the test suite
func TestE2ESuite(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping E2E tests in short mode")
	}
	
	suite.Run(t, new(E2ETestSuite))
}