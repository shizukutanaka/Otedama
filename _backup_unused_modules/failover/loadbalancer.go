package failover

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// LoadBalancer provides high-availability load balancing
type LoadBalancer struct {
	manager      *Manager
	logger       *zap.Logger
	mu           sync.RWMutex
	httpProxies  map[string]*httputil.ReverseProxy
	tcpListeners map[string]net.Listener
	running      atomic.Bool
}

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(manager *Manager, logger *zap.Logger) *LoadBalancer {
	return &LoadBalancer{
		manager:      manager,
		logger:       logger,
		httpProxies:  make(map[string]*httputil.ReverseProxy),
		tcpListeners: make(map[string]net.Listener),
	}
}

// StartHTTPProxy starts HTTP load balancing on the specified address
func (lb *LoadBalancer) StartHTTPProxy(listenAddr string) error {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	
	if _, exists := lb.httpProxies[listenAddr]; exists {
		return fmt.Errorf("HTTP proxy already running on %s", listenAddr)
	}
	
	proxy := &httputil.ReverseProxy{
		Director: lb.httpDirector,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		ModifyResponse: lb.modifyResponse,
		ErrorHandler:   lb.errorHandler,
	}
	
	lb.httpProxies[listenAddr] = proxy
	
	server := &http.Server{
		Addr:    listenAddr,
		Handler: proxy,
	}
	
	go func() {
		lb.logger.Info("Starting HTTP load balancer", zap.String("addr", listenAddr))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			lb.logger.Error("HTTP load balancer error", zap.Error(err))
		}
	}()
	
	return nil
}

// StartTCPProxy starts TCP load balancing on the specified address
func (lb *LoadBalancer) StartTCPProxy(listenAddr string) error {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	
	if _, exists := lb.tcpListeners[listenAddr]; exists {
		return fmt.Errorf("TCP proxy already running on %s", listenAddr)
	}
	
	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", listenAddr, err)
	}
	
	lb.tcpListeners[listenAddr] = listener
	
	go func() {
		lb.logger.Info("Starting TCP load balancer", zap.String("addr", listenAddr))
		for {
			conn, err := listener.Accept()
			if err != nil {
				lb.logger.Error("TCP accept error", zap.Error(err))
				continue
			}
			
			go lb.handleTCPConnection(conn)
		}
	}()
	
	return nil
}

// Stop stops all load balancing services
func (lb *LoadBalancer) Stop() error {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	
	// Close TCP listeners
	for addr, listener := range lb.tcpListeners {
		if err := listener.Close(); err != nil {
			lb.logger.Error("Error closing TCP listener", zap.String("addr", addr), zap.Error(err))
		}
	}
	lb.tcpListeners = make(map[string]net.Listener)
	
	// HTTP proxies will be closed when their servers are shut down
	lb.httpProxies = make(map[string]*httputil.ReverseProxy)
	
	lb.logger.Info("Load balancer stopped")
	return nil
}

// httpDirector modifies the request to target the selected backend
func (lb *LoadBalancer) httpDirector(req *http.Request) {
	node, err := lb.manager.GetHealthyNode()
	if err != nil {
		lb.logger.Error("No healthy nodes available for HTTP request", zap.Error(err))
		return
	}
	
	target, err := url.Parse(node.Endpoint)
	if err != nil {
		lb.logger.Error("Invalid node endpoint", zap.String("endpoint", node.Endpoint), zap.Error(err))
		return
	}
	
	req.URL.Scheme = target.Scheme
	req.URL.Host = target.Host
	req.Host = target.Host
	
	// Add load balancer headers
	req.Header.Set("X-Forwarded-For", req.RemoteAddr)
	req.Header.Set("X-Forwarded-Proto", req.URL.Scheme)
	req.Header.Set("X-LB-Node-ID", node.ID)
	
	// Store node info in context for response handling
	req = req.WithContext(context.WithValue(req.Context(), "lb_node", node))
}

// modifyResponse modifies the response from backend
func (lb *LoadBalancer) modifyResponse(resp *http.Response) error {
	// Add load balancer response headers
	resp.Header.Set("X-LB-Backend", resp.Request.Host)
	
	// Record metrics
	if node := resp.Request.Context().Value("lb_node"); node != nil {
		n := node.(*Node)
		duration := time.Since(resp.Request.Context().Value("start_time").(time.Time))
		lb.manager.RecordRequest(n.ID, duration, resp.StatusCode < 400)
	}
	
	return nil
}

// errorHandler handles proxy errors
func (lb *LoadBalancer) errorHandler(w http.ResponseWriter, req *http.Request, err error) {
	lb.logger.Error("HTTP proxy error", zap.Error(err), zap.String("url", req.URL.String()))
	
	// Record failure
	if node := req.Context().Value("lb_node"); node != nil {
		n := node.(*Node)
		lb.manager.RecordRequest(n.ID, 0, false)
	}
	
	// Try to find another healthy node for retry
	retryNode, retryErr := lb.manager.GetHealthyNode()
	if retryErr != nil {
		http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
		return
	}
	
	// Simple retry logic (should be more sophisticated in production)
	retryTarget, parseErr := url.Parse(retryNode.Endpoint)
	if parseErr != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	
	// Create new proxy for retry
	retryProxy := httputil.NewSingleHostReverseProxy(retryTarget)
	retryProxy.ServeHTTP(w, req)
}

// handleTCPConnection handles a TCP connection with load balancing
func (lb *LoadBalancer) handleTCPConnection(clientConn net.Conn) {
	defer clientConn.Close()
	
	node, err := lb.manager.GetHealthyNode()
	if err != nil {
		lb.logger.Error("No healthy nodes available for TCP connection", zap.Error(err))
		return
	}
	
	start := time.Now()
	
	// Connect to backend
	backendConn, err := net.DialTimeout("tcp", node.Endpoint, 10*time.Second)
	if err != nil {
		lb.logger.Error("Failed to connect to backend", 
			zap.String("node_id", node.ID),
			zap.String("endpoint", node.Endpoint),
			zap.Error(err))
		lb.manager.RecordRequest(node.ID, time.Since(start), false)
		return
	}
	defer backendConn.Close()
	
	lb.logger.Debug("TCP connection established",
		zap.String("node_id", node.ID),
		zap.String("client", clientConn.RemoteAddr().String()),
		zap.String("backend", node.Endpoint))
	
	// Proxy data between client and backend
	errChan := make(chan error, 2)
	
	// Client to backend
	go func() {
		_, err := io.Copy(backendConn, clientConn)
		errChan <- err
	}()
	
	// Backend to client
	go func() {
		_, err := io.Copy(clientConn, backendConn)
		errChan <- err
	}()
	
	// Wait for either direction to close or error
	err = <-errChan
	
	duration := time.Since(start)
	success := err == nil || err == io.EOF
	
	lb.manager.RecordRequest(node.ID, duration, success)
	
	if err != nil && err != io.EOF {
		lb.logger.Debug("TCP proxy connection error",
			zap.String("node_id", node.ID),
			zap.Error(err))
	}
}

// StratumProxy provides load-balanced Stratum mining
type StratumProxy struct {
	loadBalancer *LoadBalancer
	logger       *zap.Logger
}

// NewStratumProxy creates a new Stratum proxy
func NewStratumProxy(lb *LoadBalancer, logger *zap.Logger) *StratumProxy {
	return &StratumProxy{
		loadBalancer: lb,
		logger:       logger,
	}
}

// Start starts the Stratum proxy on the specified address
func (sp *StratumProxy) Start(listenAddr string) error {
	return sp.loadBalancer.StartTCPProxy(listenAddr)
}

// PoolStats returns statistics about the pool
type PoolStats struct {
	TotalNodes      int                      `json:"total_nodes"`
	HealthyNodes    int                      `json:"healthy_nodes"`
	LoadBalancing   string                   `json:"load_balancing"`
	RequestsTotal   uint64                   `json:"requests_total"`
	RequestsPerSec  float64                  `json:"requests_per_sec"`
	AvgResponseTime time.Duration            `json:"avg_response_time"`
	Nodes           []NodeStats              `json:"nodes"`
}

// NodeStats represents statistics for a single node
type NodeStats struct {
	ID           string        `json:"id"`
	Endpoint     string        `json:"endpoint"`
	State        string        `json:"state"`
	Active       bool          `json:"active"`
	RequestCount uint64        `json:"request_count"`
	FailureCount int32         `json:"failure_count"`
	ResponseTime time.Duration `json:"response_time"`
	Priority     int           `json:"priority"`
	Weight       int           `json:"weight"`
}

// GetStats returns comprehensive statistics
func (lb *LoadBalancer) GetStats() PoolStats {
	managerStats := lb.manager.GetStats()
	
	stats := PoolStats{
		TotalNodes:    managerStats["total_nodes"].(int),
		HealthyNodes:  managerStats["healthy_nodes"].(int),
		LoadBalancing: managerStats["load_balancing"].(string),
	}
	
	if nodeStats, ok := managerStats["nodes"].([]map[string]interface{}); ok {
		stats.Nodes = make([]NodeStats, len(nodeStats))
		for i, ns := range nodeStats {
			stats.Nodes[i] = NodeStats{
				ID:           ns["id"].(string),
				Endpoint:     ns["endpoint"].(string),
				State:        ns["state"].(string),
				Active:       ns["active"].(bool),
				RequestCount: ns["request_count"].(uint64),
				FailureCount: ns["failure_count"].(int32),
				ResponseTime: time.Duration(ns["response_time_ms"].(int64)) * time.Millisecond,
				Priority:     ns["priority"].(int),
				Weight:       ns["weight"].(int),
			}
			
			stats.RequestsTotal += stats.Nodes[i].RequestCount
		}
	}
	
	return stats
}