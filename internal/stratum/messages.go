package stratum

import (
	"encoding/json"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// Message represents a Stratum message - optimized for JSON-RPC
type Message struct {
	ID     interface{} `json:"id"`
	Method string      `json:"method,omitempty"`
	Params interface{} `json:"params,omitempty"`
	Result interface{} `json:"result,omitempty"`
	Error  *Error      `json:"error,omitempty"`
}

// Error represents a Stratum error
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Job represents a mining job - cache-aligned for performance
type Job struct {
	ID           string   `json:"id"`
	PrevHash     string   `json:"prevhash"`
	CoinbaseA    string   `json:"coinb1"`
	CoinbaseB    string   `json:"coinb2"`
	MerkleBranch []string `json:"merkle_branch"`
	Version      string   `json:"version"`
	NBits        string   `json:"nbits"`
	NTime        string   `json:"ntime"`
	CleanJobs    bool     `json:"clean_jobs"`
	
	// Internal fields
	Height       uint64    `json:"height,omitempty"`
	Target       string    `json:"target,omitempty"`
	Difficulty   float64   `json:"difficulty,omitempty"`
	CreatedAt    time.Time `json:"created_at,omitempty"`
}

// Share represents a submitted share - optimized for validation
type Share struct {
	JobID      string    `json:"job_id"`
	WorkerName string    `json:"worker_name"`
	Nonce      string    `json:"nonce"`
	Hash       string    `json:"hash,omitempty"`
	Difficulty float64   `json:"difficulty"`
	Timestamp  int64     `json:"timestamp"`
	
	// Validation results
	Valid      bool      `json:"valid,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	IsBlock    bool      `json:"is_block,omitempty"`
}

// processMessage processes a client message and returns a response
func (s *StratumServer) processMessage(client *Client, message *Message) *Message {
	start := time.Now()
	
	var response *Message
	
	switch message.Method {
	case "mining.subscribe":
		response = s.handleSubscribe(client, message)
	case "mining.authorize":
		response = s.handleAuthorize(client, message)
	case "mining.submit":
		response = s.handleSubmit(client, message)
	case "mining.suggest_difficulty":
		response = s.handleSuggestDifficulty(client, message)
	case "mining.zkp_auth":
		response = s.handleZKPAuth(client, message)
	default:
		response = &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Unknown method"},
		}
	}
	
	// Update response time
	responseTime := time.Since(start)
	s.updateAvgResponseTime(responseTime)
	
	return response
}

// handleSubscribe handles mining.subscribe request
func (s *StratumServer) handleSubscribe(client *Client, message *Message) *Message {
	// Extract subscription parameters
	params, ok := message.Params.([]interface{})
	if ok && len(params) > 0 {
		if userAgent, ok := params[0].(string); ok {
			client.UserAgent = userAgent
		}
	}
	
	// Send current mining job
	job := s.currentJob.Load().(*Job)
	s.sendJob(client, job, true)
	
	// Return subscription result
	return &Message{
		ID:     message.ID,
		Result: []interface{}{
			[]interface{}{
				[]interface{}{"mining.set_difficulty", client.ID},
				[]interface{}{"mining.notify", client.ID},
			},
			client.ID, // Extra nonce 1
			4,         // Extra nonce 2 size
		},
	}
}

// handleAuthorize handles mining.authorize request
func (s *StratumServer) handleAuthorize(client *Client, message *Message) *Message {
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 2 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	username, ok1 := params[0].(string)
	password, ok2 := params[1].(string)
	
	if !ok1 || !ok2 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	// Authenticate based on configured mode
	var authError error
	
	if s.config.AuthMode == AuthModeZKP {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Use ZKP authentication method"},
		}
	}
	
	authorized, err := s.authenticateWorker(username, password, s.config.AuthMode)
	if err != nil {
		authError = err
	} else if !authorized {
		authError = fmt.Errorf("authentication failed")
	}
	
	// Fallback to callback if available
	if authError != nil && s.callbacks != nil && s.callbacks.OnAuth != nil {
		authError = s.callbacks.OnAuth(username, password)
	}
	
	if authError != nil {
		s.logger.Debug("Authorization failed", 
			zap.String("client_id", client.ID),
			zap.String("username", username),
			zap.Error(authError),
		)
		
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Authorization failed"},
		}
	}
	
	// Authorization successful
	client.WorkerName = username
	client.Authorized.Store(true)
	
	// Update reputation score for successful auth
	s.reputationManager.UpdateScore(username, 1.0)
	
	s.logger.Debug("Client authorized", 
		zap.String("client_id", client.ID),
		zap.String("worker_name", username),
	)
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

// handleSubmit handles mining.submit request
func (s *StratumServer) handleSubmit(client *Client, message *Message) *Message {
	if !client.Authorized.Load() {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Not authorized"},
		}
	}
	
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 5 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	// Extract share parameters
	workerName, _ := params[0].(string)
	jobID, _ := params[1].(string)
	nonce, _ := params[4].(string)
	
	// Create share
	share := &Share{
		JobID:      jobID,
		WorkerName: workerName,
		Nonce:      nonce,
		Difficulty: client.Difficulty.Load().(float64),
		Timestamp:  time.Now().Unix(),
	}
	
	// Submit share via callback
	var shareError error
	if s.callbacks != nil && s.callbacks.OnShare != nil {
		shareError = s.callbacks.OnShare(share)
	}
	
	client.SharesSubmitted.Add(1)
	s.stats.TotalShares.Add(1)
	
	if shareError != nil {
		client.SharesRejected.Add(1)
		s.stats.RejectedShares.Add(1)
		
		s.logger.Debug("Share rejected", 
			zap.String("client_id", client.ID),
			zap.String("reason", shareError.Error()),
		)
		
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: shareError.Error()},
		}
	}
	
	client.SharesAccepted.Add(1)
	s.stats.AcceptedShares.Add(1)
	
	if share.IsBlock {
		s.stats.BlocksFound.Add(1)
		s.logger.Info("Block found!", 
			zap.String("client_id", client.ID),
			zap.String("worker", workerName),
		)
	}
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

// handleSuggestDifficulty handles mining.suggest_difficulty request
func (s *StratumServer) handleSuggestDifficulty(client *Client, message *Message) *Message {
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 1 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	difficulty, ok := params[0].(float64)
	if !ok {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid difficulty"},
		}
	}
	
	// Validate difficulty range
	if difficulty < s.config.MinDifficulty {
		difficulty = s.config.MinDifficulty
	} else if difficulty > s.config.MaxDifficulty {
		difficulty = s.config.MaxDifficulty
	}
	
	// Update client difficulty
	client.Difficulty.Store(difficulty)
	client.LastDiffAdjust.Store(time.Now().Unix())
	
	// Send difficulty notification
	s.sendDifficulty(client, difficulty)
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

// handleZKPAuth handles Zero-Knowledge Proof authentication
func (s *StratumServer) handleZKPAuth(client *Client, message *Message) *Message {
	params, ok := message.Params.([]interface{})
	if !ok || len(params) < 2 {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid parameters"},
		}
	}
	
	workerName, ok := params[0].(string)
	if !ok {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid worker name"},
		}
	}
	
	proofData, ok := params[1].(map[string]interface{})
	if !ok {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid proof data"},
		}
	}
	
	// Verify ZKP proof
	verified, err := s.verifyZKPProof(workerName, proofData)
	if err != nil {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: fmt.Sprintf("ZKP verification failed: %v", err)},
		}
	}
	
	if !verified {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Invalid ZKP proof"},
		}
	}
	
	// ZKP authentication successful
	client.WorkerName = workerName
	client.Authorized.Store(true)
	s.stats.AuthorizedClients.Add(1)
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}
