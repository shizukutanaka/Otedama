package failover

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// HTTPHealthChecker performs HTTP health checks
type HTTPHealthChecker struct {
	Path       string
	Method     string
	ExpectedStatus int
	Timeout    time.Duration
	TLSConfig  *tls.Config
}

// NewHTTPHealthChecker creates a new HTTP health checker
func NewHTTPHealthChecker(path, method string, expectedStatus int, timeout time.Duration) *HTTPHealthChecker {
	if method == "" {
		method = "GET"
	}
	if expectedStatus == 0 {
		expectedStatus = 200
	}
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	
	return &HTTPHealthChecker{
		Path:           path,
		Method:         method,
		ExpectedStatus: expectedStatus,
		Timeout:        timeout,
	}
}

// Check performs HTTP health check
func (h *HTTPHealthChecker) Check(ctx context.Context, endpoint string) error {
	client := &http.Client{
		Timeout: h.Timeout,
		Transport: &http.Transport{
			TLSClientConfig: h.TLSConfig,
		},
	}
	
	url := endpoint
	if h.Path != "" {
		if !strings.HasSuffix(endpoint, "/") && !strings.HasPrefix(h.Path, "/") {
			url += "/"
		}
		url += h.Path
	}
	
	req, err := http.NewRequestWithContext(ctx, h.Method, url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != h.ExpectedStatus {
		return fmt.Errorf("unexpected status code: %d (expected %d)", resp.StatusCode, h.ExpectedStatus)
	}
	
	return nil
}

// TCPHealthChecker performs TCP connection health checks
type TCPHealthChecker struct {
	Timeout time.Duration
}

// NewTCPHealthChecker creates a new TCP health checker
func NewTCPHealthChecker(timeout time.Duration) *TCPHealthChecker {
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	
	return &TCPHealthChecker{
		Timeout: timeout,
	}
}

// Check performs TCP health check
func (t *TCPHealthChecker) Check(ctx context.Context, endpoint string) error {
	d := net.Dialer{Timeout: t.Timeout}
	conn, err := d.DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return fmt.Errorf("TCP connection failed: %w", err)
	}
	defer conn.Close()
	
	return nil
}

// StratumHealthChecker performs Stratum protocol health checks
type StratumHealthChecker struct {
	Timeout time.Duration
}

// NewStratumHealthChecker creates a new Stratum health checker
func NewStratumHealthChecker(timeout time.Duration) *StratumHealthChecker {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	
	return &StratumHealthChecker{
		Timeout: timeout,
	}
}

// Check performs Stratum health check
func (s *StratumHealthChecker) Check(ctx context.Context, endpoint string) error {
	d := net.Dialer{Timeout: s.Timeout}
	conn, err := d.DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return fmt.Errorf("Stratum connection failed: %w", err)
	}
	defer conn.Close()
	
	// Send mining.subscribe request
	request := map[string]interface{}{
		"id":     1,
		"method": "mining.subscribe",
		"params": []string{"otedama-healthcheck/1.0"},
	}
	
	requestData, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}
	
	requestData = append(requestData, '\n')
	
	// Set deadline for the entire operation
	deadline := time.Now().Add(s.Timeout)
	conn.SetDeadline(deadline)
	
	// Send request
	_, err = conn.Write(requestData)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	
	// Read response
	buffer := make([]byte, 1024)
	n, err := conn.Read(buffer)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}
	
	// Parse response
	var response map[string]interface{}
	if err := json.Unmarshal(buffer[:n], &response); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	// Check for error in response
	if errObj, exists := response["error"]; exists && errObj != nil {
		return fmt.Errorf("Stratum error: %v", errObj)
	}
	
	// Check if we got a result
	if _, exists := response["result"]; !exists {
		return fmt.Errorf("no result in Stratum response")
	}
	
	return nil
}

// P2PHealthChecker performs P2P network health checks
type P2PHealthChecker struct {
	Timeout time.Duration
}

// NewP2PHealthChecker creates a new P2P health checker
func NewP2PHealthChecker(timeout time.Duration) *P2PHealthChecker {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	
	return &P2PHealthChecker{
		Timeout: timeout,
	}
}

// Check performs P2P health check
func (p *P2PHealthChecker) Check(ctx context.Context, endpoint string) error {
	d := net.Dialer{Timeout: p.Timeout}
	conn, err := d.DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return fmt.Errorf("P2P connection failed: %w", err)
	}
	defer conn.Close()
	
	// Send a simple ping message
	ping := []byte("PING\n")
	
	// Set deadline
	deadline := time.Now().Add(p.Timeout)
	conn.SetDeadline(deadline)
	
	// Send ping
	_, err = conn.Write(ping)
	if err != nil {
		return fmt.Errorf("failed to send ping: %w", err)
	}
	
	// Read response
	buffer := make([]byte, 64)
	n, err := conn.Read(buffer)
	if err != nil {
		return fmt.Errorf("failed to read pong: %w", err)
	}
	
	response := string(buffer[:n])
	if !strings.Contains(response, "PONG") {
		return fmt.Errorf("unexpected response: %s", response)
	}
	
	return nil
}

// CompositeHealthChecker combines multiple health checkers
type CompositeHealthChecker struct {
	Checkers []HealthChecker
	Strategy string // "all" or "any"
}

// NewCompositeHealthChecker creates a new composite health checker
func NewCompositeHealthChecker(strategy string, checkers ...HealthChecker) *CompositeHealthChecker {
	if strategy == "" {
		strategy = "all"
	}
	
	return &CompositeHealthChecker{
		Checkers: checkers,
		Strategy: strategy,
	}
}

// Check performs composite health check
func (c *CompositeHealthChecker) Check(ctx context.Context, endpoint string) error {
	if len(c.Checkers) == 0 {
		return fmt.Errorf("no health checkers configured")
	}
	
	var lastError error
	successCount := 0
	
	for i, checker := range c.Checkers {
		err := checker.Check(ctx, endpoint)
		if err != nil {
			lastError = fmt.Errorf("checker %d failed: %w", i, err)
		} else {
			successCount++
		}
		
		// For "any" strategy, return success on first successful check
		if c.Strategy == "any" && err == nil {
			return nil
		}
		
		// For "all" strategy, return error on first failed check
		if c.Strategy == "all" && err != nil {
			return lastError
		}
	}
	
	// Final evaluation
	if c.Strategy == "any" {
		if successCount == 0 {
			return fmt.Errorf("all health checks failed, last error: %v", lastError)
		}
		return nil
	}
	
	// Strategy is "all"
	if successCount == len(c.Checkers) {
		return nil
	}
	
	return lastError
}