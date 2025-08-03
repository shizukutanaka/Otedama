package mining

// Unified type definitions to eliminate duplication across the codebase
// Following Rob Pike's principle: "A little copying is better than a little dependency"
// Following Robert C. Martin's DRY principle: Don't Repeat Yourself

import (
	"time"
)

// Core Algorithm Types - Single source of truth

// AlgorithmType represents supported mining algorithms
type AlgorithmType string

const (
	SHA256     AlgorithmType = "sha256"
	SHA256D    AlgorithmType = "sha256d"
	Scrypt     AlgorithmType = "scrypt"
	Blake2b256 AlgorithmType = "blake2b256"
	Blake3     AlgorithmType = "blake3"
	SHA3_256   AlgorithmType = "sha3_256"
	RandomX    AlgorithmType = "randomx"
	Ethash     AlgorithmType = "ethash"
	Equihash   AlgorithmType = "equihash"
	X16R       AlgorithmType = "x16r"
	KHeavyHash AlgorithmType = "kheavyhash"
	Autolykos  AlgorithmType = "autolykos"
	KawPow     AlgorithmType = "kawpow"
	ProgPow    AlgorithmType = "progpow"
	CryptoNight AlgorithmType = "cryptonight"
)

// Legacy alias for compatibility
type Algorithm = AlgorithmType

// Hardware Types - Single source of truth

// HardwareType represents the type of mining hardware
type HardwareType string

const (
	HardwareCPU  HardwareType = "cpu"
	HardwareGPU  HardwareType = "gpu"
	HardwareASIC HardwareType = "asic"
)

// WorkerType defines worker hardware type
type WorkerType int8

const (
	WorkerCPU WorkerType = iota
	WorkerGPU
	WorkerASIC
)

// Job Types - Single source of truth

// Job represents a mining job - memory layout optimized
type Job struct {
	ID           string        `json:"id"`
	Height       uint64        `json:"height"`
	PrevHash     [32]byte      `json:"prev_hash"`
	MerkleRoot   [32]byte      `json:"merkle_root"`
	Timestamp    uint32        `json:"timestamp"`
	Bits         uint32        `json:"bits"`
	Nonce        uint32        `json:"nonce"`
	Algorithm    AlgorithmType `json:"algorithm"`
	Difficulty   uint64        `json:"difficulty"`
	CleanJobs    bool          `json:"clean_jobs"`
	// Additional fields aligned to cache line
	_ [16]byte // padding to 128 bytes
}

// MiningJob represents a detailed mining job with extended features
type MiningJob struct {
	ID         string        `json:"id"`
	Algorithm  AlgorithmType `json:"algorithm"`
	Target     []byte        `json:"target"`
	BlockData  []byte        `json:"block_data"`
	ExtraNonce uint32        `json:"extra_nonce"`
	Height     uint64        `json:"height"`
	Difficulty uint64        `json:"difficulty"`
	Priority   JobPriority   `json:"priority"`
	CreatedAt  time.Time     `json:"created_at"`
	ExpiresAt  time.Time     `json:"expires_at"`
	
	// Block header fields
	PrevHash   [32]byte `json:"prev_hash"`
	MerkleRoot [32]byte `json:"merkle_root"`
	Timestamp  uint32   `json:"timestamp"`
	Bits       uint32   `json:"bits"`
	Nonce      uint32   `json:"nonce"`
	CleanJobs  bool     `json:"clean_jobs"`
	
	// Creator and callback
	Creator    string               `json:"creator"`
	OnComplete func(*JobResult)     `json:"-"`
}

// JobPriority defines job priority levels
type JobPriority int

const (
	PriorityLow JobPriority = iota
	PriorityNormal
	PriorityHigh
)

// JobResult contains the result of a mining job
type JobResult struct {
	JobID     string    `json:"job_id"`
	Success   bool      `json:"success"`
	Nonce     uint64    `json:"nonce"`
	Hash      []byte    `json:"hash"`
	Timestamp time.Time `json:"timestamp"`
}

// Share Types - Single source of truth

// Share represents a mining share - optimized for validation
type Share struct {
	JobID        string        `json:"job_id"`
	WorkerID     string        `json:"worker_id"`
	Nonce        uint64        `json:"nonce"`
	Hash         [32]byte      `json:"hash"`
	Difficulty   uint64        `json:"difficulty"`
	Timestamp    int64         `json:"timestamp"`
	Algorithm    AlgorithmType `json:"algorithm"`
	Valid        bool          `json:"valid"`
}

// ValidationResult contains the result of share validation
type ValidationResult struct {
	Valid      bool   `json:"valid"`
	IsBlock    bool   `json:"is_block"`
	Reason     string `json:"reason"`
	Difficulty uint64 `json:"difficulty"`
}

// Algorithm Configuration Types

// Algorithm represents a mining algorithm with profitability data
type AlgorithmConfig struct {
	Name        string                 `json:"name"`
	HashFunc    func([]byte) []byte    `json:"-"`
	Difficulty  float64                `json:"difficulty"`
	BlockReward float64                `json:"block_reward"`
	Profitable  bool                   `json:"profitable"`
	LastUpdate  time.Time              `json:"last_update"`
	Threads     int                    `json:"threads"`
	WorkSize    int                    `json:"work_size"`
	CacheSize   int                    `json:"cache_size"`
	GPUEnabled  bool                   `json:"gpu_enabled"`
}

// ProfitabilityData represents profitability information
type ProfitabilityData struct {
	Algorithm     AlgorithmType `json:"algorithm"`
	Hashrate      float64       `json:"hashrate"`
	Difficulty    float64       `json:"difficulty"`
	BlockReward   float64       `json:"block_reward"`
	PowerCost     float64       `json:"power_cost"`
	CoinPrice     float64       `json:"coin_price"`
	Profitability float64       `json:"profitability"`
	LastUpdate    time.Time     `json:"last_update"`
}

// Worker and Pool Types

// WorkerStats represents worker statistics
type WorkerStats struct {
	ID              string    `json:"id"`
	HashRate        uint64    `json:"hash_rate"`
	SharesSubmitted uint64    `json:"shares_submitted"`
	SharesAccepted  uint64    `json:"shares_accepted"`
	LastShare       time.Time `json:"last_share"`
	JobsCompleted   uint64    `json:"jobs_completed"`
	HashesComputed  uint64    `json:"hashes_computed"`
}

// Statistics Types

// Stats contains mining statistics - atomic for lock-free access
type Stats struct {
	TotalHashRate   uint64        `json:"total_hash_rate"`
	CPUHashRate     uint64        `json:"cpu_hash_rate"`
	GPUHashRate     uint64        `json:"gpu_hash_rate"`
	ASICHashRate    uint64        `json:"asic_hash_rate"`
	SharesSubmitted uint64        `json:"shares_submitted"`
	SharesAccepted  uint64        `json:"shares_accepted"`
	SharesRejected  uint64        `json:"shares_rejected"`
	BlocksFound     uint64        `json:"blocks_found"`
	MemoryUsageMB   uint64        `json:"memory_usage_mb"`
	ActiveWorkers   int32         `json:"active_workers"`
	Uptime          time.Duration `json:"uptime"`
	CurrentHashRate uint64        `json:"current_hash_rate"`
	Errors          uint64        `json:"errors"`
}

// QueueStats contains queue statistics
type QueueStats struct {
	Enqueued   uint64         `json:"enqueued"`
	Dequeued   uint64         `json:"dequeued"`
	Completed  uint64         `json:"completed"`
	Expired    uint64         `json:"expired"`
	InProgress int32          `json:"in_progress"`
	Active     int            `json:"active"`
	QueueSizes map[string]int `json:"queue_sizes"`
}

// AlgoStats tracks algorithm performance
type AlgoStats struct {
	TotalHashes   uint64        `json:"total_hashes"`
	TotalShares   uint64        `json:"total_shares"`
	TotalTime     time.Duration `json:"total_time"`
	LastHashRate  uint64        `json:"last_hash_rate"`
	Profitability float64       `json:"profitability"`
}

// Hardware Information Types

// HardwareInfo represents hardware information
type HardwareInfo struct {
	CPUThreads   int                    `json:"cpu_threads"`
	GPUDevices   []GPUInfo              `json:"gpu_devices"`
	ASICDevices  []ASICInfo             `json:"asic_devices"`
	TotalMemory  uint64                 `json:"total_memory"`
	AvailMemory  uint64                 `json:"avail_memory"`
}

// GPUInfo represents GPU device information
type GPUInfo struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Memory   uint64 `json:"memory"`
	Temp     int    `json:"temp"`
	FanSpeed int    `json:"fan_speed"`
}

// ASICInfo represents ASIC device information
type ASICInfo struct {
	ID     string `json:"id"`
	Model  string `json:"model"`
	Status string `json:"status"`
	Temp   int    `json:"temp"`
}

// Engine Status Types

// EngineStatus represents engine status
type EngineStatus struct {
	Running   bool          `json:"running"`
	Algorithm AlgorithmType `json:"algorithm"`
	Pool      string        `json:"pool"`
	Wallet    string        `json:"wallet"`
	Uptime    time.Duration `json:"uptime"`
}

// StatsSnapshot represents a point-in-time stats snapshot
type StatsSnapshot struct {
	Timestamp time.Time `json:"timestamp"`
	Stats     Stats     `json:"stats"`
}

// ASIC Device Types

// ASICDevice represents an ASIC mining device
type ASICDevice struct {
	ID           string  `json:"id"`
	Model        string  `json:"model"`
	Algorithm    string  `json:"algorithm"`
	HashRate     uint64  `json:"hash_rate"`
	PowerUsage   float64 `json:"power_usage"`
}

// Utility Functions

// String returns string representation of priority
func (p JobPriority) String() string {
	switch p {
	case PriorityHigh:
		return "high"
	case PriorityNormal:
		return "normal"
	case PriorityLow:
		return "low"
	default:
		return "unknown"
	}
}

// ParseAlgorithm parses algorithm from string
func ParseAlgorithm(s string) AlgorithmType {
	switch s {
	case "sha256", "SHA256":
		return SHA256
	case "sha256d", "SHA256D":
		return SHA256D
	case "scrypt", "Scrypt":
		return Scrypt
	case "ethash", "Ethash":
		return Ethash
	case "randomx", "RandomX":
		return RandomX
	case "kawpow", "KawPow":
		return KawPow
	default:
		return "unknown"
	}
}

// IsValid checks if an algorithm is valid
func (a AlgorithmType) IsValid() bool {
	switch a {
	case SHA256, SHA256D, Scrypt, Blake2b256, Blake3, SHA3_256,
		 RandomX, Ethash, Equihash, X16R, KHeavyHash, Autolykos,
		 KawPow, ProgPow, CryptoNight:
		return true
	default:
		return false
	}
}

// String returns the string representation of HardwareType
func (h HardwareType) String() string {
	return string(h)
}

// String returns the string representation of WorkerType
func (w WorkerType) String() string {
	switch w {
	case WorkerCPU:
		return "cpu"
	case WorkerGPU:
		return "gpu"
	case WorkerASIC:
		return "asic"
	default:
		return "unknown"
	}
}
