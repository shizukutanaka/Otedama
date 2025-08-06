package stratum

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Client represents a connected Stratum client
type Client struct {
	ID         string    `json:"id"`
	RemoteAddr string    `json:"remote_addr"`
	WorkerName string    `json:"worker_name"`
	UserAgent  string    `json:"user_agent"`
	
	// Connection state - atomic for lock-free access
	Connected    atomic.Bool   `json:"connected"`
	Authorized   atomic.Bool   `json:"authorized"`
	ConnectedAt  time.Time     `json:"connected_at"`
	LastActivity atomic.Int64  `json:"last_activity"`
	
	// Statistics - atomic for performance
	SharesSubmitted atomic.Uint64 `json:"shares_submitted"`
	SharesAccepted  atomic.Uint64 `json:"shares_accepted"`
	SharesRejected  atomic.Uint64 `json:"shares_rejected"`
	CurrentHashRate atomic.Uint64 `json:"current_hash_rate"`
	
	// Variable difficulty
	Difficulty      atomic.Value  // stores float64
	LastDiffAdjust  atomic.Int64  // Unix timestamp
	
	// Connection
	conn         net.Conn      `json:"-"`
	reader       *bufio.Reader `json:"-"`
	writer       *bufio.Writer `json:"-"`
	
	// Synchronization
	writeMutex   sync.Mutex    `json:"-"`
	
	// Rate limiting
	messageCount atomic.Uint64 `json:"message_count"`
	lastReset    atomic.Int64  `json:"last_reset"`
}

// handleClient handles a new client connection.
// It initializes the client, manages its lifecycle, and cleans up on disconnect.
func (s *StratumServer) handleClient(conn net.Conn) {
	defer conn.Close()
	
	// Initialize client connection
	client, err := s.initializeClient(conn)
	if err != nil {
		s.logger.Error("Failed to initialize client", zap.Error(err))
		return
	}
	
	// Register client
	s.registerClient(client)
	
	// Handle client messages
	s.clientMessageLoop(client)
	
	// Cleanup on disconnect
	s.unregisterClient(client)
}

// initializeClient creates and configures a new client.
// Extracted for better testability and separation of concerns.
func (s *StratumServer) initializeClient(conn net.Conn) (*Client, error) {
	// Set connection timeouts
	if err := s.configureConnection(conn); err != nil {
		return nil, fmt.Errorf("failed to configure connection: %w", err)
	}
	
	// Create client instance
	client := s.createClient(conn)
	
	return client, nil
}

// configureConnection sets timeouts and other connection parameters.
// Extracted for clarity and reusability.
func (s *StratumServer) configureConnection(conn net.Conn) error {
	if err := conn.SetReadDeadline(time.Now().Add(s.config.ReadTimeout)); err != nil {
		return fmt.Errorf("failed to set read deadline: %w", err)
	}
	
	if err := conn.SetWriteDeadline(time.Now().Add(s.config.WriteTimeout)); err != nil {
		return fmt.Errorf("failed to set write deadline: %w", err)
	}
	
	return nil
}

// createClient creates a new client instance with default values.
// Extracted to centralize client creation logic.
func (s *StratumServer) createClient(conn net.Conn) *Client {
	client := &Client{
		ID:          generateClientID(),
		RemoteAddr:  conn.RemoteAddr().String(),
		ConnectedAt: time.Now(),
		conn:        conn,
		reader:      bufio.NewReaderSize(conn, s.config.BufferSize),
		writer:      bufio.NewWriterSize(conn, s.config.BufferSize),
	}
	
	// Initialize atomic values
	client.Connected.Store(true)
	client.LastActivity.Store(time.Now().Unix())
	client.Difficulty.Store(s.config.Difficulty)
	
	return client
}

// registerClient adds a client to the server's client registry.
// Extracted to isolate registration logic.
func (s *StratumServer) registerClient(client *Client) {
	s.clients.Store(client.ID, client)
	s.clientCount.Add(1)
	s.stats.TotalConnections.Add(1)
	
	s.logger.Debug("New client connected",
		zap.String("client_id", client.ID),
		zap.String("remote_addr", client.RemoteAddr),
	)
}

// unregisterClient removes a client from the server's client registry.
// Extracted to centralize cleanup logic.
func (s *StratumServer) unregisterClient(client *Client) {
	s.clients.Delete(client.ID)
	s.clientCount.Add(-1)
	client.Connected.Store(false)
	
	s.logger.Debug("Client disconnected", zap.String("client_id", client.ID))
}

// clientMessageLoop handles messages from a client
func (s *StratumServer) clientMessageLoop(client *Client) {
	for {
		select {
		case <-s.ctx.Done():
			return
		default:
		}
		
		// Read message
		message, err := s.readMessage(client)
		if err != nil {
			s.logger.Debug("Read message failed", 
				zap.String("client_id", client.ID),
				zap.Error(err),
			)
			return
		}
		
		// Rate limiting
		if !s.rateLimiter.Allow(client.ID) {
			s.logger.Debug("Client rate limited", zap.String("client_id", client.ID))
			continue
		}
		
		// Process message
		response := s.processMessage(client, message)
		
		// Send response if needed
		if response != nil {
			if err := s.sendMessage(client, response); err != nil {
				s.logger.Error("Send response failed", 
					zap.String("client_id", client.ID),
					zap.Error(err),
				)
				return
			}
		}
		
		// Update activity
		client.LastActivity.Store(time.Now().Unix())
	}
}

// readMessage reads a message from the client
func (s *StratumServer) readMessage(client *Client) (*Message, error) {
	// Set read deadline
	if err := client.conn.SetReadDeadline(time.Now().Add(s.config.ReadTimeout)); err != nil {
		return nil, err
	}
	
	// Read line
	line, err := client.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	
	// Check message size
	if len(line) > s.config.MaxMessageSize {
		return nil, fmt.Errorf("message too large: %d bytes", len(line))
	}
	
	// Parse JSON
	var message Message
	if err := json.Unmarshal(line, &message); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	
	return &message, nil
}

// sendMessage sends a message to the client
func (s *StratumServer) sendMessage(client *Client, message *Message) error {
	// Serialize message
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	
	// Add newline
	data = append(data, '\n')
	
	// Set write deadline
	if err := client.conn.SetWriteDeadline(time.Now().Add(s.config.WriteTimeout)); err != nil {
		return err
	}
	
	// Write with mutex protection
	client.writeMutex.Lock()
	defer client.writeMutex.Unlock()
	
	if _, err := client.writer.Write(data); err != nil {
		return err
	}
	
	return client.writer.Flush()
}

// sendJob sends a mining job to the client
func (s *StratumServer) sendJob(client *Client, job *Job, cleanJobs bool) {
	notification := &Message{
		Method: "mining.notify",
		Params: []interface{}{
			job.ID,
			job.PrevHash,
			job.CoinbaseA,
			job.CoinbaseB,
			job.MerkleBranch,
			job.Version,
			job.NBits,
			job.NTime,
			cleanJobs,
		},
	}
	
	if err := s.sendMessage(client, notification); err != nil {
		s.logger.Error("Failed to send job", 
			zap.String("client_id", client.ID),
			zap.Error(err),
		)
	} else {
		s.stats.JobsDistributed.Add(1)
	}
}

// sendDifficulty sends difficulty update to the client
func (s *StratumServer) sendDifficulty(client *Client, difficulty float64) {
	notification := &Message{
		Method: "mining.set_difficulty",
		Params: []interface{}{difficulty},
	}
	
	if err := s.sendMessage(client, notification); err != nil {
		s.logger.Error("Failed to send difficulty", 
			zap.String("client_id", client.ID),
			zap.Error(err),
		)
	}
}

// adjustDifficulties adjusts difficulty for all clients
func (s *StratumServer) adjustDifficulties() {
	if s.difficultyAdjuster == nil {
		// Fallback to simple adjustment
		s.simpleAdjustDifficulties()
		return
	}
	
	now := time.Now()
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		
		if !client.Authorized.Load() {
			return true
		}
		
		// Build worker stats
		stats := &WorkerStats{
			LastShareTime:   now,
			ShareCount:      client.SharesSubmitted.Load(),
			CurrentDiff:     client.Difficulty.Load().(float64),
			AverageHashRate: float64(client.CurrentHashRate.Load()),
			ShareTimes:      s.getClientShareTimes(client),
		}
		
		// Use advanced difficulty adjustment
		newDiff := s.difficultyAdjuster.AdjustDifficulty(stats)
		
		// Apply if different
		currentDiff := client.Difficulty.Load().(float64)
		if newDiff != currentDiff {
			client.Difficulty.Store(newDiff)
			client.LastDiffAdjust.Store(now.Unix())
			s.sendDifficulty(client, newDiff)
			
			// Record share for history
			s.difficultyAdjuster.RecordShare(now, newDiff, true)
			
			s.logger.Debug("Adjusted difficulty (advanced)", 
				zap.String("client_id", client.ID),
				zap.Float64("old_diff", currentDiff),
				zap.Float64("new_diff", newDiff),
			)
		}
		
		return true
	})
}

// simpleAdjustDifficulties performs simple difficulty adjustment
func (s *StratumServer) simpleAdjustDifficulties() {
	now := time.Now().Unix()
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		
		if !client.Authorized.Load() {
			return true
		}
		
		// Check if adjustment is needed
		lastAdjust := client.LastDiffAdjust.Load()
		if now-lastAdjust < int64(s.config.TargetTime.Seconds()*2) {
			return true
		}
		
		// Calculate new difficulty based on share rate
		currentDiff := client.Difficulty.Load().(float64)
		shareRate := calculateShareRate(client)
		
		targetRate := 1.0 / s.config.TargetTime.Seconds()
		newDiff := currentDiff * (shareRate / targetRate)
		
		// Clamp to limits
		if newDiff < s.config.MinDifficulty {
			newDiff = s.config.MinDifficulty
		} else if newDiff > s.config.MaxDifficulty {
			newDiff = s.config.MaxDifficulty
		}
		
		// Apply if significantly different
		if abs(newDiff-currentDiff)/currentDiff > 0.1 {
			client.Difficulty.Store(newDiff)
			client.LastDiffAdjust.Store(now)
			s.sendDifficulty(client, newDiff)
			
			s.logger.Debug("Adjusted difficulty (simple)", 
				zap.String("client_id", client.ID),
				zap.Float64("old_diff", currentDiff),
				zap.Float64("new_diff", newDiff),
			)
		}
		
		return true
	})
}

// getClientShareTimes returns share time history for a client
func (s *StratumServer) getClientShareTimes(client *Client) []time.Duration {
	// TODO: Implement actual share time tracking
	// For now, return estimated times based on share rate
	shareRate := calculateShareRate(client)
	if shareRate > 0 {
		avgTime := time.Duration(1.0/shareRate) * time.Second
		return []time.Duration{avgTime, avgTime, avgTime}
	}
	return []time.Duration{}
}
