// Stratum Protocol Server for P2Pool Bridge
//
// Lightweight Stratum V1 implementation for miner connections

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// StratumServer handles Stratum protocol connections
type StratumServer struct {
	config   *Config
	listener net.Listener
	clients  map[string]*StratumClient
	jobs     map[string]*Job
	mutex    sync.RWMutex
	jobID    uint64
}

// StratumClient represents a connected miner
type StratumClient struct {
	conn        net.Conn
	address     string
	subscribed  bool
	authorized  bool
	difficulty  float64
	extranonce1 string
	lastActive  time.Time
	mutex       sync.Mutex
}

// Job represents mining work
type Job struct {
	ID        string    `json:"job_id"`
	PrevHash  string    `json:"prevhash"`
	Coinbase1 string    `json:"coinb1"`
	Coinbase2 string    `json:"coinb2"`
	Merkle    []string  `json:"merkle_branch"`
	Version   string    `json:"version"`
	NBits     string    `json:"nbits"`
	NTime     string    `json:"ntime"`
	CleanJobs bool      `json:"clean_jobs"`
	CreatedAt time.Time `json:"created_at"`
}

// StratumRequest represents incoming Stratum request
type StratumRequest struct {
	ID     interface{} `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

// StratumResponse represents outgoing Stratum response
type StratumResponse struct {
	ID     interface{} `json:"id"`
	Result interface{} `json:"result"`
	Error  interface{} `json:"error"`
}

// StratumNotification represents server-initiated message
type StratumNotification struct {
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

// NewStratumServer creates a new Stratum server
func NewStratumServer(cfg *Config) *StratumServer {
	return &StratumServer{
		config:  cfg,
		clients: make(map[string]*StratumClient),
		jobs:    make(map[string]*Job),
	}
}

// Start starts the Stratum server
func (s *StratumServer) Start(ctx context.Context) error {
	address := fmt.Sprintf("%s:%d", s.config.Stratum.Host, s.config.Stratum.Port)
	
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("failed to start Stratum server: %w", err)
	}
	
	s.listener = listener
	log.WithField("address", address).Info("Starting Stratum server")
	
	// Start job generator
	go s.generateJobs(ctx)
	
	// Start client cleanup
	go s.cleanupClients(ctx)
	
	// Accept connections
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
					log.WithError(err).Error("Accept connection failed")
					continue
				}
			}
			
			go s.handleClient(ctx, conn)
		}
	}()
	
	// Wait for context cancellation
	<-ctx.Done()
	return s.shutdown()
}

// shutdown gracefully shuts down the server
func (s *StratumServer) shutdown() error {
	log.Info("Shutting down Stratum server")
	
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Close all client connections
	s.mutex.Lock()
	for _, client := range s.clients {
		client.conn.Close()
	}
	s.clients = make(map[string]*StratumClient)
	s.mutex.Unlock()
	
	return nil
}

// handleClient handles a single client connection
func (s *StratumServer) handleClient(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	
	clientAddr := conn.RemoteAddr().String()
	log.WithField("client", clientAddr).Info("New Stratum client connected")
	
	client := &StratumClient{
		conn:       conn,
		address:    clientAddr,
		difficulty: 1000.0, // Default difficulty
		lastActive: time.Now(),
	}
	
	s.mutex.Lock()
	s.clients[clientAddr] = client
	s.mutex.Unlock()
	
	defer func() {
		s.mutex.Lock()
		delete(s.clients, clientAddr)
		s.mutex.Unlock()
		log.WithField("client", clientAddr).Info("Stratum client disconnected")
	}()
	
	scanner := bufio.NewScanner(conn)
	
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		
		client.mutex.Lock()
		client.lastActive = time.Now()
		client.mutex.Unlock()
		
		if err := s.handleMessage(client, line); err != nil {
			log.WithError(err).WithField("client", clientAddr).Error("Error handling message")
			return
		}
	}
	
	if err := scanner.Err(); err != nil {
		log.WithError(err).WithField("client", clientAddr).Error("Scanner error")
	}
}

// handleMessage processes a Stratum message
func (s *StratumServer) handleMessage(client *StratumClient, message string) error {
	var req StratumRequest
	if err := json.Unmarshal([]byte(message), &req); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	
	log.WithFields(logrus.Fields{
		"client": client.address,
		"method": req.Method,
	}).Debug("Received Stratum message")
	
	switch req.Method {
	case "mining.subscribe":
		return s.handleSubscribe(client, req)
	case "mining.authorize":
		return s.handleAuthorize(client, req)
	case "mining.submit":
		return s.handleSubmit(client, req)
	case "mining.suggest_difficulty":
		return s.handleSuggestDifficulty(client, req)
	default:
		return s.sendError(client, req.ID, fmt.Sprintf("Unknown method: %s", req.Method))
	}
}

// handleSubscribe handles mining.subscribe
func (s *StratumServer) handleSubscribe(client *StratumClient, req StratumRequest) error {
	client.mutex.Lock()
	client.subscribed = true
	client.extranonce1 = s.generateExtranonce1()
	client.mutex.Unlock()
	
	// Response: [[[mining.set_difficulty, subscription_id], [mining.notify, subscription_id]], extranonce1, extranonce2_size]
	response := StratumResponse{
		ID: req.ID,
		Result: []interface{}{
			[][]interface{}{
				{"mining.set_difficulty", "subscription_id_1"},
				{"mining.notify", "subscription_id_2"},
			},
			client.extranonce1,
			s.config.Stratum.ExtraNonce1Size,
		},
	}
	
	if err := s.sendResponse(client, response); err != nil {
		return err
	}
	
	// Send initial difficulty
	return s.sendDifficulty(client, client.difficulty)
}

// handleAuthorize handles mining.authorize
func (s *StratumServer) handleAuthorize(client *StratumClient, req StratumRequest) error {
	params, ok := req.Params.([]interface{})
	if !ok || len(params) < 2 {
		return s.sendError(client, req.ID, "Invalid authorize parameters")
	}
	
	username, ok := params[0].(string)
	if !ok {
		return s.sendError(client, req.ID, "Invalid username")
	}
	
	// Simple authorization - in production, validate against allowed addresses
	client.mutex.Lock()
	client.authorized = true
	client.mutex.Unlock()
	
	log.WithFields(logrus.Fields{
		"client":   client.address,
		"username": username,
	}).Info("Miner authorized")
	
	response := StratumResponse{
		ID:     req.ID,
		Result: true,
	}
	
	if err := s.sendResponse(client, response); err != nil {
		return err
	}
	
	// Send current job
	return s.sendCurrentJob(client)
}

// handleSubmit handles mining.submit
func (s *StratumServer) handleSubmit(client *StratumClient, req StratumRequest) error {
	if !client.authorized {
		return s.sendError(client, req.ID, "Not authorized")
	}
	
	params, ok := req.Params.([]interface{})
	if !ok || len(params) < 5 {
		return s.sendError(client, req.ID, "Invalid submit parameters")
	}
	
	username := params[0].(string)
	jobID := params[1].(string)
	extranonce2 := params[2].(string)
	ntime := params[3].(string)
	nonce := params[4].(string)
	
	log.WithFields(logrus.Fields{
		"client":      client.address,
		"username":    username,
		"job_id":      jobID,
		"extranonce2": extranonce2,
		"ntime":       ntime,
		"nonce":       nonce,
	}).Info("Share submitted")
	
	// Validate job exists
	s.mutex.RLock()
	job, exists := s.jobs[jobID]
	s.mutex.RUnlock()
	
	if !exists {
		return s.sendError(client, req.ID, "Job not found")
	}
	
	// TODO: Validate share against job
	// For now, accept all shares
	_ = job
	
	response := StratumResponse{
		ID:     req.ID,
		Result: true,
	}
	
	return s.sendResponse(client, response)
}

// handleSuggestDifficulty handles mining.suggest_difficulty
func (s *StratumServer) handleSuggestDifficulty(client *StratumClient, req StratumRequest) error {
	params, ok := req.Params.([]interface{})
	if !ok || len(params) < 1 {
		return s.sendError(client, req.ID, "Invalid difficulty parameters")
	}
	
	difficulty, ok := params[0].(float64)
	if !ok {
		return s.sendError(client, req.ID, "Invalid difficulty value")
	}
	
	client.mutex.Lock()
	client.difficulty = difficulty
	client.mutex.Unlock()
	
	response := StratumResponse{
		ID:     req.ID,
		Result: true,
	}
	
	return s.sendResponse(client, response)
}

// sendResponse sends a response to client
func (s *StratumServer) sendResponse(client *StratumClient, response StratumResponse) error {
	data, err := json.Marshal(response)
	if err != nil {
		return err
	}
	
	_, err = client.conn.Write(append(data, '\n'))
	return err
}

// sendError sends an error response to client
func (s *StratumServer) sendError(client *StratumClient, id interface{}, message string) error {
	response := StratumResponse{
		ID:    id,
		Error: []interface{}{-1, message, nil},
	}
	
	return s.sendResponse(client, response)
}

// sendNotification sends a notification to client
func (s *StratumServer) sendNotification(client *StratumClient, method string, params interface{}) error {
	notification := StratumNotification{
		Method: method,
		Params: params,
	}
	
	data, err := json.Marshal(notification)
	if err != nil {
		return err
	}
	
	_, err = client.conn.Write(append(data, '\n'))
	return err
}

// sendDifficulty sends difficulty change notification
func (s *StratumServer) sendDifficulty(client *StratumClient, difficulty float64) error {
	return s.sendNotification(client, "mining.set_difficulty", []interface{}{difficulty})
}

// sendCurrentJob sends current job to client
func (s *StratumServer) sendCurrentJob(client *StratumClient) error {
	s.mutex.RLock()
	var currentJob *Job
	for _, job := range s.jobs {
		if currentJob == nil || job.CreatedAt.After(currentJob.CreatedAt) {
			currentJob = job
		}
	}
	s.mutex.RUnlock()
	
	if currentJob == nil {
		return nil // No job available yet
	}
	
	params := []interface{}{
		currentJob.ID,
		currentJob.PrevHash,
		currentJob.Coinbase1,
		currentJob.Coinbase2,
		currentJob.Merkle,
		currentJob.Version,
		currentJob.NBits,
		currentJob.NTime,
		currentJob.CleanJobs,
	}
	
	return s.sendNotification(client, "mining.notify", params)
}

// generateJobs creates new mining jobs periodically
func (s *StratumServer) generateJobs(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second) // New job every 30 seconds
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			job := s.createNewJob()
			s.broadcastJob(job)
		}
	}
}

// createNewJob creates a new mining job
func (s *StratumServer) createNewJob() *Job {
	s.jobID++
	
	job := &Job{
		ID:        fmt.Sprintf("%08x", s.jobID),
		PrevHash:  "0000000000000000000000000000000000000000000000000000000000000000",
		Coinbase1: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
		Coinbase2: "ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000",
		Merkle:    []string{},
		Version:   "00000001",
		NBits:     "1d00ffff",
		NTime:     fmt.Sprintf("%08x", time.Now().Unix()),
		CleanJobs: true,
		CreatedAt: time.Now(),
	}
	
	s.mutex.Lock()
	s.jobs[job.ID] = job
	
	// Keep only last 10 jobs
	if len(s.jobs) > 10 {
		var oldestTime time.Time
		var oldestID string
		for id, j := range s.jobs {
			if oldestTime.IsZero() || j.CreatedAt.Before(oldestTime) {
				oldestTime = j.CreatedAt
				oldestID = id
			}
		}
		delete(s.jobs, oldestID)
	}
	s.mutex.Unlock()
	
	return job
}

// broadcastJob sends new job to all connected miners
func (s *StratumServer) broadcastJob(job *Job) {
	s.mutex.RLock()
	clients := make([]*StratumClient, 0, len(s.clients))
	for _, client := range s.clients {
		if client.authorized {
			clients = append(clients, client)
		}
	}
	s.mutex.RUnlock()
	
	params := []interface{}{
		job.ID,
		job.PrevHash,
		job.Coinbase1,
		job.Coinbase2,
		job.Merkle,
		job.Version,
		job.NBits,
		job.NTime,
		job.CleanJobs,
	}
	
	for _, client := range clients {
		if err := s.sendNotification(client, "mining.notify", params); err != nil {
			log.WithError(err).WithField("client", client.address).Error("Failed to send job")
		}
	}
	
	log.WithFields(logrus.Fields{
		"job_id": job.ID,
		"clients": len(clients),
	}).Info("Broadcasted new job")
}

// generateExtranonce1 generates unique extranonce1 for client
func (s *StratumServer) generateExtranonce1() string {
	return fmt.Sprintf("%08x", time.Now().UnixNano()%0xFFFFFFFF)
}

// cleanupClients removes inactive clients
func (s *StratumServer) cleanupClients(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			timeout := 5 * time.Minute
			
			s.mutex.Lock()
			for addr, client := range s.clients {
				client.mutex.Lock()
				if now.Sub(client.lastActive) > timeout {
					client.conn.Close()
					delete(s.clients, addr)
					log.WithField("client", addr).Info("Cleaned up inactive client")
				}
				client.mutex.Unlock()
			}
			s.mutex.Unlock()
		}
	}
}
