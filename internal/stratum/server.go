package stratum

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/config"
	"go.uber.org/zap"
)

// Server represents a Stratum server
type Server struct {
	logger *zap.Logger
	config *config.StratumConfig
	
	// Network
	listener net.Listener
	
	// Sessions
	sessions     map[string]*Session
	sessionsMu   sync.RWMutex
	sessionCount uint64
	
	// Job management
	currentJob   *Job
	jobID        uint64
	jobsMu       sync.RWMutex
	
	// Statistics
	stats        *ServerStats
	
	// Channels
	submitChan   chan *ShareSubmission
	
	// Lifecycle
	running      bool
	stopChan     chan struct{}
	wg           sync.WaitGroup
}

// Session represents a miner session
type Session struct {
	ID           string
	conn         net.Conn
	reader       *bufio.Reader
	writer       *bufio.Writer
	
	// Miner info
	workerName   string
	authorized   bool
	
	// Session state
	extraNonce1  string
	difficulty   float64
	
	// Statistics
	validShares   uint64
	invalidShares uint64
	lastShare     time.Time
	
	// Channels
	jobChan      chan *Job
	stopChan     chan struct{}
	
	mu           sync.RWMutex
}

// ShareSubmission represents a share submission
type ShareSubmission struct {
	SessionID    string
	JobID        string
	ExtraNonce2  string
	NTime        string
	Nonce        string
	Result       chan bool
}

// ServerStats tracks server statistics
type ServerStats struct {
	StartTime      time.Time
	Connections    uint64
	ValidShares    uint64
	InvalidShares  uint64
	BlocksFound    uint64
	TotalHashrate  float64
	
	mu             sync.RWMutex
}

// NewServer creates a new Stratum server
func NewServer(logger *zap.Logger, config *config.StratumConfig) *Server {
	return &Server{
		logger:     logger,
		config:     config,
		sessions:   make(map[string]*Session),
		submitChan: make(chan *ShareSubmission, 1000),
		stopChan:   make(chan struct{}),
		stats:      &ServerStats{StartTime: time.Now()},
	}
}

// Start starts the Stratum server
func (s *Server) Start() error {
	if s.running {
		return fmt.Errorf("server already running")
	}
	
	s.logger.Info("Starting Stratum server", zap.String("address", s.config.Address))
	
	// Start listening
	listener, err := net.Listen("tcp", s.config.Address)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	s.listener = listener
	
	s.running = true
	
	// Start background workers
	s.wg.Add(3)
	go s.acceptLoop()
	go s.shareProcessor()
	go s.statsReporter()
	
	// Generate initial job
	s.generateJob()
	
	s.logger.Info("Stratum server started successfully")
	
	return nil
}

// Stop stops the Stratum server
func (s *Server) Stop() error {
	if !s.running {
		return nil
	}
	
	s.logger.Info("Stopping Stratum server")
	
	s.running = false
	close(s.stopChan)
	
	// Close listener
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Close all sessions
	s.sessionsMu.Lock()
	for _, session := range s.sessions {
		session.Close()
	}
	s.sessionsMu.Unlock()
	
	// Wait for workers
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	
	select {
	case <-done:
		s.logger.Info("Stratum server stopped")
	case <-time.After(10 * time.Second):
		s.logger.Warn("Timeout waiting for Stratum server to stop")
	}
	
	return nil
}

// acceptLoop accepts incoming connections
func (s *Server) acceptLoop() {
	defer s.wg.Done()
	
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.stopChan:
				return
			default:
				s.logger.Error("Failed to accept connection", zap.Error(err))
				continue
			}
		}
		
		// Create session
		sessionID := fmt.Sprintf("session-%d", atomic.AddUint64(&s.sessionCount, 1))
		session := &Session{
			ID:          sessionID,
			conn:        conn,
			reader:      bufio.NewReader(conn),
			writer:      bufio.NewWriter(conn),
			extraNonce1: generateExtraNonce1(),
			difficulty:  s.config.Difficulty.Initial,
			jobChan:     make(chan *Job, 10),
			stopChan:    make(chan struct{}),
		}
		
		// Add session
		s.sessionsMu.Lock()
		s.sessions[sessionID] = session
		s.sessionsMu.Unlock()
		
		// Update stats
		atomic.AddUint64(&s.stats.Connections, 1)
		
		// Handle session
		s.wg.Add(1)
		go s.handleSession(session)
		
		s.logger.Info("New connection", 
			zap.String("session", sessionID),
			zap.String("address", conn.RemoteAddr().String()))
	}
}

// handleSession handles a miner session
func (s *Server) handleSession(session *Session) {
	defer s.wg.Done()
	defer s.removeSession(session.ID)
	defer session.Close()
	
	// Start message reader
	go s.readMessages(session)
	
	// Send jobs to session
	for {
		select {
		case <-s.stopChan:
			return
		case <-session.stopChan:
			return
		case job := <-session.jobChan:
			s.sendJob(session, job)
		case <-time.After(30 * time.Second):
			// Check if session is still alive
			if !s.ping(session) {
				s.logger.Info("Session timeout", zap.String("session", session.ID))
				return
			}
		}
	}
}

// readMessages reads messages from a session
func (s *Server) readMessages(session *Session) {
	for {
		line, err := session.reader.ReadBytes('\n')
		if err != nil {
			close(session.stopChan)
			return
		}
		
		// Parse JSON-RPC request
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			s.logger.Error("Failed to parse request", 
				zap.String("session", session.ID),
				zap.Error(err))
			continue
		}
		
		// Handle request
		s.handleRequest(session, &req)
	}
}

// handleRequest handles a JSON-RPC request
func (s *Server) handleRequest(session *Session, req *Request) {
	s.logger.Debug("Request received",
		zap.String("session", session.ID),
		zap.String("method", req.Method))
	
	switch req.Method {
	case "mining.subscribe":
		s.handleSubscribe(session, req)
	case "mining.authorize":
		s.handleAuthorize(session, req)
	case "mining.submit":
		s.handleSubmit(session, req)
	case "mining.get_transactions":
		s.handleGetTransactions(session, req)
	case "mining.extranonce.subscribe":
		s.handleExtranonceSubscribe(session, req)
	default:
		s.sendError(session, req.ID, -3, "Method not found")
	}
}

// handleSubscribe handles mining.subscribe
func (s *Server) handleSubscribe(session *Session, req *Request) {
	// Parse parameters
	var params []interface{}
	if req.Params != nil {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			s.sendError(session, req.ID, -1, "Invalid parameters")
			return
		}
	}
	
	// Send subscription response
	result := []interface{}{
		[]interface{}{
			[]interface{}{"mining.set_difficulty", "1"},
			[]interface{}{"mining.notify", "1"},
		},
		session.extraNonce1,
		s.config.ExtraNonceSize,
	}
	
	s.sendResult(session, req.ID, result)
	
	// Send initial difficulty
	s.sendDifficulty(session, session.difficulty)
	
	// Send current job
	s.jobsMu.RLock()
	job := s.currentJob
	s.jobsMu.RUnlock()
	
	if job != nil {
		s.sendJob(session, job)
	}
}

// handleAuthorize handles mining.authorize
func (s *Server) handleAuthorize(session *Session, req *Request) {
	// Parse parameters
	var params []string
	if err := json.Unmarshal(req.Params, &params); err != nil || len(params) < 2 {
		s.sendError(session, req.ID, -1, "Invalid parameters")
		return
	}
	
	workerName := params[0]
	password := params[1]
	
	// TODO: Implement actual authorization
	_ = password
	
	session.mu.Lock()
	session.workerName = workerName
	session.authorized = true
	session.mu.Unlock()
	
	s.sendResult(session, req.ID, true)
	
	s.logger.Info("Worker authorized",
		zap.String("session", session.ID),
		zap.String("worker", workerName))
}

// handleSubmit handles mining.submit
func (s *Server) handleSubmit(session *Session, req *Request) {
	// Check authorization
	session.mu.RLock()
	authorized := session.authorized
	session.mu.RUnlock()
	
	if !authorized {
		s.sendError(session, req.ID, -1, "Not authorized")
		return
	}
	
	// Parse parameters
	var params []string
	if err := json.Unmarshal(req.Params, &params); err != nil || len(params) < 5 {
		s.sendError(session, req.ID, -1, "Invalid parameters")
		return
	}
	
	// workerName := params[0]
	jobID := params[1]
	extraNonce2 := params[2]
	ntime := params[3]
	nonce := params[4]
	
	// Create submission
	submission := &ShareSubmission{
		SessionID:   session.ID,
		JobID:       jobID,
		ExtraNonce2: extraNonce2,
		NTime:       ntime,
		Nonce:       nonce,
		Result:      make(chan bool, 1),
	}
	
	// Submit for validation
	select {
	case s.submitChan <- submission:
		// Wait for result
		select {
		case valid := <-submission.Result:
			if valid {
				atomic.AddUint64(&session.validShares, 1)
				atomic.AddUint64(&s.stats.ValidShares, 1)
				s.sendResult(session, req.ID, true)
			} else {
				atomic.AddUint64(&session.invalidShares, 1)
				atomic.AddUint64(&s.stats.InvalidShares, 1)
				s.sendError(session, req.ID, 23, "Invalid share")
			}
			session.lastShare = time.Now()
		case <-time.After(5 * time.Second):
			s.sendError(session, req.ID, 20, "Timeout")
		}
	default:
		s.sendError(session, req.ID, 21, "Job not found")
	}
}

// handleGetTransactions handles mining.get_transactions
func (s *Server) handleGetTransactions(session *Session, req *Request) {
	// Return empty transaction list for now
	s.sendResult(session, req.ID, []string{})
}

// handleExtranonceSubscribe handles mining.extranonce.subscribe
func (s *Server) handleExtranonceSubscribe(session *Session, req *Request) {
	s.sendResult(session, req.ID, true)
}

// sendResult sends a successful result
func (s *Server) sendResult(session *Session, id uint64, result interface{}) {
	resp := &Response{
		ID:     id,
		Result: result,
		Error:  nil,
	}
	
	s.sendResponse(session, resp)
}

// sendError sends an error response
func (s *Server) sendError(session *Session, id uint64, code int, message string) {
	resp := &Response{
		ID:     id,
		Result: nil,
		Error: &Error{
			Code:    code,
			Message: message,
		},
	}
	
	s.sendResponse(session, resp)
}

// sendResponse sends a JSON-RPC response
func (s *Server) sendResponse(session *Session, resp *Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		s.logger.Error("Failed to marshal response", zap.Error(err))
		return
	}
	
	session.mu.Lock()
	defer session.mu.Unlock()
	
	if _, err := session.writer.Write(data); err != nil {
		s.logger.Error("Failed to write response", zap.Error(err))
		return
	}
	
	if err := session.writer.WriteByte('\n'); err != nil {
		s.logger.Error("Failed to write newline", zap.Error(err))
		return
	}
	
	if err := session.writer.Flush(); err != nil {
		s.logger.Error("Failed to flush", zap.Error(err))
	}
}

// sendNotification sends a JSON-RPC notification
func (s *Server) sendNotification(session *Session, method string, params interface{}) {
	notif := map[string]interface{}{
		"id":     nil,
		"method": method,
		"params": params,
	}
	
	data, err := json.Marshal(notif)
	if err != nil {
		s.logger.Error("Failed to marshal notification", zap.Error(err))
		return
	}
	
	session.mu.Lock()
	defer session.mu.Unlock()
	
	if _, err := session.writer.Write(data); err != nil {
		return
	}
	
	if err := session.writer.WriteByte('\n'); err != nil {
		return
	}
	
	session.writer.Flush()
}

// sendDifficulty sends mining.set_difficulty
func (s *Server) sendDifficulty(session *Session, difficulty float64) {
	s.sendNotification(session, "mining.set_difficulty", []interface{}{difficulty})
}

// sendJob sends mining.notify
func (s *Server) sendJob(session *Session, job *Job) {
	params := []interface{}{
		job.ID,
		job.PrevHash,
		job.Coinbase1,
		job.Coinbase2,
		job.MerkleBranch,
		job.Version,
		job.NBits,
		job.NTime,
		job.CleanJobs,
	}
	
	s.sendNotification(session, "mining.notify", params)
}

// ping sends a ping to check if session is alive
func (s *Server) ping(session *Session) bool {
	// Try to write a newline
	session.mu.Lock()
	defer session.mu.Unlock()
	
	if err := session.writer.WriteByte('\n'); err != nil {
		return false
	}
	
	return session.writer.Flush() == nil
}

// generateJob generates a new mining job
func (s *Server) generateJob() {
	jobID := fmt.Sprintf("%x", atomic.AddUint64(&s.jobID, 1))
	
	job := &Job{
		ID:           jobID,
		PrevHash:     generateRandomHex(64),
		Coinbase1:    generateRandomHex(100),
		Coinbase2:    generateRandomHex(100),
		MerkleBranch: []string{},
		Version:      "00000020",
		NBits:        "1d00ffff",
		NTime:        fmt.Sprintf("%08x", time.Now().Unix()),
		CleanJobs:    true,
	}
	
	s.jobsMu.Lock()
	s.currentJob = job
	s.jobsMu.Unlock()
	
	// Broadcast to all sessions
	s.broadcastJob(job)
}

// broadcastJob broadcasts a job to all sessions
func (s *Server) broadcastJob(job *Job) {
	s.sessionsMu.RLock()
	sessions := make([]*Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		sessions = append(sessions, session)
	}
	s.sessionsMu.RUnlock()
	
	for _, session := range sessions {
		select {
		case session.jobChan <- job:
		default:
			// Channel full, skip
		}
	}
}

// shareProcessor processes share submissions
func (s *Server) shareProcessor() {
	defer s.wg.Done()
	
	for {
		select {
		case <-s.stopChan:
			return
		case submission := <-s.submitChan:
			// TODO: Validate share
			// For now, accept all shares
			submission.Result <- true
		}
	}
}

// statsReporter reports statistics periodically
func (s *Server) statsReporter() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.stopChan:
			return
		case <-ticker.C:
			s.reportStats()
		}
	}
}

// reportStats logs current statistics
func (s *Server) reportStats() {
	s.stats.mu.RLock()
	validShares := s.stats.ValidShares
	invalidShares := s.stats.InvalidShares
	connections := s.stats.Connections
	s.stats.mu.RUnlock()
	
	s.sessionsMu.RLock()
	activeSessions := len(s.sessions)
	s.sessionsMu.RUnlock()
	
	s.logger.Info("Stratum server statistics",
		zap.Uint64("connections_total", connections),
		zap.Int("sessions_active", activeSessions),
		zap.Uint64("shares_valid", validShares),
		zap.Uint64("shares_invalid", invalidShares))
}

// removeSession removes a session
func (s *Server) removeSession(id string) {
	s.sessionsMu.Lock()
	defer s.sessionsMu.Unlock()
	
	if session, exists := s.sessions[id]; exists {
		delete(s.sessions, id)
		
		s.logger.Info("Session removed",
			zap.String("session", id),
			zap.String("worker", session.workerName),
			zap.Uint64("valid_shares", session.validShares),
			zap.Uint64("invalid_shares", session.invalidShares))
	}
}

// GetStats returns server statistics
func (s *Server) GetStats() ServerStats {
	s.stats.mu.RLock()
	defer s.stats.mu.RUnlock()
	return *s.stats
}

// GetActiveSessions returns the number of active sessions
func (s *Server) GetActiveSessions() int {
	s.sessionsMu.RLock()
	defer s.sessionsMu.RUnlock()
	return len(s.sessions)
}

// Session methods

// Close closes the session
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	if s.conn != nil {
		s.conn.Close()
	}
}

// Helper functions

// generateExtraNonce1 generates a unique extranonce1
func generateExtraNonce1() string {
	return generateRandomHex(8)
}

// generateRandomHex generates random hex string
func generateRandomHex(length int) string {
	bytes := make([]byte, length/2)
	for i := range bytes {
		bytes[i] = byte(time.Now().UnixNano() & 0xFF)
	}
	return fmt.Sprintf("%x", bytes)
}

// Response represents a JSON-RPC response for server
type Response struct {
	ID     uint64      `json:"id"`
	Result interface{} `json:"result"`
	Error  *Error      `json:"error"`
}
