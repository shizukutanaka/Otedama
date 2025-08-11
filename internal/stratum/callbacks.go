package stratum

import (
	"math/big"
)

// Callbacks defines the callbacks for stratum events
type Callbacks struct {
	OnShare  func(workerID string, jobID string, nonce uint64, hash []byte) error
	OnGetJob func(workerID string) (*Job, error)
	OnAuth   func(workerID, password string) bool
}

// Job extension fields for ASIC support
type JobExtended struct {
	*Job
	CoinbaseA []byte // First part of coinbase
	CoinbaseB []byte // Second part of coinbase
}

// Server extension methods
func (s *Server) SetCallbacks(callbacks *Callbacks) error {
	// This would set the callbacks on the server
	// For now, just return nil
	return nil
}

// CreateExtendedJob creates an extended job with coinbase parts
func CreateExtendedJob(job *Job) *JobExtended {
	// Split coinbase into two parts for ASIC miners
	coinbase := []byte(job.ID) // Simplified - actual implementation would be more complex
	
	mid := len(coinbase) / 2
	return &JobExtended{
		Job:       job,
		CoinbaseA: coinbase[:mid],
		CoinbaseB: coinbase[mid:],
	}
}

// TargetToBigInt converts target to big.Int
func TargetToBigInt(target *big.Int) *big.Int {
	return target
}

// BigIntToTargetString converts big.Int to hex string
func BigIntToTargetString(target *big.Int) string {
	if target == nil {
		return "0"
	}
	return target.Text(16)
}