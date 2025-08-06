package stratum

import (
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

// handleAuthorize handles mining.authorize request.
// It validates credentials and updates client authorization status.
func (s *StratumServer) handleAuthorize(client *Client, message *Message) *Message {
	// Parse authorization parameters
	authParams, err := s.parseAuthParameters(message.Params)
	if err != nil {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: err.Error()},
		}
	}
	
	// Check authentication mode
	if err := s.validateAuthMode(); err != nil {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: err.Error()},
		}
	}
	
	// Perform authentication
	authResult := s.performAuthentication(authParams)
	
	// Handle authentication result
	if authResult.Error != nil {
		s.handleAuthFailure(client, authParams.username, authResult.Error)
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: "Authorization failed"},
		}
	}
	
	// Handle successful authentication
	s.handleAuthSuccess(client, authParams.username)
	
	return &Message{
		ID:     message.ID,
		Result: true,
	}
}

// authParameters holds authentication credentials.
type authParameters struct {
	username string
	password string
}

// parseAuthParameters extracts authentication parameters from the message.
// Extracted to isolate parameter parsing logic.
func (s *StratumServer) parseAuthParameters(params interface{}) (*authParameters, error) {
	paramSlice, ok := params.([]interface{})
	if !ok || len(paramSlice) < 2 {
		return nil, fmt.Errorf("invalid parameters")
	}
	
	username, ok1 := paramSlice[0].(string)
	password, ok2 := paramSlice[1].(string)
	
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("invalid parameter types")
	}
	
	return &authParameters{
		username: username,
		password: password,
	}, nil
}

// validateAuthMode checks if the current authentication mode is valid.
// Extracted for clarity.
func (s *StratumServer) validateAuthMode() error {
	if s.config.AuthMode == AuthModeZKP {
		return fmt.Errorf("use ZKP authentication method")
	}
	return nil
}

// authenticationResult holds the result of authentication attempts.
type authenticationResult struct {
	Authorized bool
	Error      error
}

// performAuthentication attempts to authenticate using configured methods.
// Extracted to centralize authentication logic.
func (s *StratumServer) performAuthentication(params *authParameters) *authenticationResult {
	// Try primary authentication
	authorized, err := s.authenticateWorker(params.username, params.password, s.config.AuthMode)
	
	if err != nil || !authorized {
		// Try callback authentication as fallback
		if s.callbacks != nil && s.callbacks.OnAuth != nil {
			err = s.callbacks.OnAuth(params.username, params.password)
			authorized = (err == nil)
		} else if err == nil && !authorized {
			err = fmt.Errorf("authentication failed")
		}
	}
	
	return &authenticationResult{
		Authorized: authorized,
		Error:      err,
	}
}

// handleAuthFailure logs authentication failures.
// Extracted to centralize failure handling.
func (s *StratumServer) handleAuthFailure(client *Client, username string, err error) {
	s.logger.Debug("Authorization failed",
		zap.String("client_id", client.ID),
		zap.String("username", username),
		zap.Error(err),
	)
}

// handleAuthSuccess updates client state for successful authentication.
// Extracted to centralize success handling.
func (s *StratumServer) handleAuthSuccess(client *Client, username string) {
	client.WorkerName = username
	client.Authorized.Store(true)
	
	// Update reputation score for successful auth
	s.reputationManager.UpdateScore(username, 1.0)
	
	s.logger.Debug("Client authorized",
		zap.String("client_id", client.ID),
		zap.String("worker_name", username),
	)

// handleSubmit handles mining.submit request.
// It validates authorization, parses parameters, and processes the share submission.
func (s *StratumServer) handleSubmit(client *Client, message *Message) *Message {
	// Validate client authorization
	if err := s.validateClientAuthorization(client); err != nil {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: err.Error()},
		}
	}
	
	// Parse share parameters
	shareParams, err := s.parseShareParameters(message.Params)
	if err != nil {
		return &Message{
			ID:    message.ID,
			Error: &Error{Code: -1, Message: err.Error()},
		}
	}
	
	// Create and process share
	share := s.createShare(shareParams, client)
	result := s.processShareSubmission(client, share)
	
	return &Message{
		ID:     message.ID,
		Result: result.Success,
		Error:  result.Error,
	}
}

// validateClientAuthorization checks if the client is authorized.
// Extracted for clarity and reusability.
func (s *StratumServer) validateClientAuthorization(client *Client) error {
	if !client.Authorized.Load() {
		return fmt.Errorf("not authorized")
	}
	return nil
}

// shareParameters holds extracted share submission parameters.
type shareParameters struct {
	workerName string
	jobID      string
	nonce      string
}

// parseShareParameters extracts and validates share parameters from the message.
// Extracted to separate parsing logic from business logic.
func (s *StratumServer) parseShareParameters(params interface{}) (*shareParameters, error) {
	paramSlice, ok := params.([]interface{})
	if !ok || len(paramSlice) < 5 {
		return nil, fmt.Errorf("invalid parameters")
	}
	
	workerName, _ := paramSlice[0].(string)
	jobID, _ := paramSlice[1].(string)
	nonce, _ := paramSlice[4].(string)
	
	return &shareParameters{
		workerName: workerName,
		jobID:      jobID,
		nonce:      nonce,
	}, nil
}

// createShare creates a share object from parameters and client data.
// Extracted to centralize share creation logic.
func (s *StratumServer) createShare(params *shareParameters, client *Client) *Share {
	return &Share{
		JobID:      params.jobID,
		WorkerName: params.workerName,
		Nonce:      params.nonce,
		Difficulty: client.Difficulty.Load().(float64),
		Timestamp:  time.Now().Unix(),
	}
}

// shareSubmissionResult holds the result of share processing.
type shareSubmissionResult struct {
	Success bool
	Error   *Error
}

// processShareSubmission handles the share submission logic.
// Extracted to isolate share processing and statistics updates.
func (s *StratumServer) processShareSubmission(client *Client, share *Share) *shareSubmissionResult {
	// Update submission statistics
	client.SharesSubmitted.Add(1)
	s.stats.TotalShares.Add(1)
	
	// Submit share via callback
	if err := s.submitShareCallback(share); err != nil {
		s.handleRejectedShare(client, err)
		return &shareSubmissionResult{
			Success: false,
			Error:   &Error{Code: -1, Message: err.Error()},
		}
	}
	
	// Handle accepted share
	s.handleAcceptedShare(client, share)
	
	return &shareSubmissionResult{
		Success: true,
		Error:   nil,
	}
}

// submitShareCallback invokes the share callback if available.
// Extracted to isolate callback handling.
func (s *StratumServer) submitShareCallback(share *Share) error {
	if s.callbacks != nil && s.callbacks.OnShare != nil {
		return s.callbacks.OnShare(share)
	}
	return nil
}

// handleRejectedShare updates statistics and logs rejected shares.
// Extracted to centralize rejection handling.
func (s *StratumServer) handleRejectedShare(client *Client, err error) {
	client.SharesRejected.Add(1)
	s.stats.RejectedShares.Add(1)
	
	s.logger.Debug("Share rejected",
		zap.String("client_id", client.ID),
		zap.String("reason", err.Error()),
	)
}

// handleAcceptedShare updates statistics and handles block discoveries.
// Extracted to centralize acceptance handling.
func (s *StratumServer) handleAcceptedShare(client *Client, share *Share) {
	client.SharesAccepted.Add(1)
	s.stats.AcceptedShares.Add(1)
	
	if share.IsBlock {
		s.handleBlockFound(client, share)
	}
}

// handleBlockFound processes block discoveries.
// Extracted for clarity and potential future expansion.
func (s *StratumServer) handleBlockFound(client *Client, share *Share) {
	s.stats.BlocksFound.Add(1)
	s.logger.Info("Block found!",
		zap.String("client_id", client.ID),
		zap.String("worker", share.WorkerName),
	)

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
