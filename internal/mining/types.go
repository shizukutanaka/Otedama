package mining

import (
	"sync/atomic"
	"time"
)

// AlgorithmType represents supported mining algorithms
type AlgorithmType string

const (
	SHA256      AlgorithmType = "sha256"
	SHA256D     AlgorithmType = "sha256d"
	Scrypt      AlgorithmType = "scrypt"
	Blake2b256  AlgorithmType = "blake2b256"
	Blake3      AlgorithmType = "blake3"
	SHA3_256    AlgorithmType = "sha3_256"
	RandomX     AlgorithmType = "randomx"
	Ethash      AlgorithmType = "ethash"
	Equihash    AlgorithmType = "equihash"
	X16R        AlgorithmType = "x16r"
	KHeavyHash  AlgorithmType = "kheavyhash"
	Autolykos   AlgorithmType = "autolykos"
	KawPow      AlgorithmType = "kawpow"
	ProgPow     AlgorithmType = "progpow"
	CryptoNight AlgorithmType = "cryptonight"
)

// JobPriority defines job priority levels
type JobPriority int32

const (
	PriorityLow JobPriority = iota
	PriorityNormal
	PriorityHigh
)

// JobLike defines the interface for any job type in the queue.
type JobLike interface {
	GetID() string
	GetPriority() JobPriority
	GetCreationTime() time.Time
}

// Job represents a legacy mining job for backward compatibility.
type Job struct {
	ID         string        `json:"id"`
	Height     uint64        `json:"height"`
	PrevHash   [32]byte      `json:"prev_hash"`
	MerkleRoot [32]byte      `json:"merkle_root"`
	Timestamp  uint32        `json:"timestamp"`
	Bits       uint32        `json:"bits"`
	Nonce      uint32        `json:"nonce"`
	Algorithm  AlgorithmType `json:"algorithm"`
	Difficulty uint64        `json:"difficulty"`
	CleanJobs  bool          `json:"clean_jobs"`
}

func (j *Job) GetID() string                { return j.ID }
func (j *Job) GetPriority() JobPriority       { return PriorityNormal } // Legacy jobs are always normal priority
func (j *Job) GetCreationTime() time.Time { return time.Time{} }      // Legacy jobs don't have creation time

// MiningJob represents a detailed mining job with extended features.
type MiningJob struct {
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
	Target       []byte        `json:"target"`
	BlockData    []byte        `json:"block_data"`
	ExtraNonce   uint32        `json:"extra_nonce"`
	Priority     JobPriority   `json:"priority"`
	RetryCount   int64         `json:"retry_count"`
	CreatedAt    time.Time     `json:"created_at"`
	ExpiresAt    time.Time     `json:"expires_at"`
	Creator      string        `json:"creator"`
	OnComplete   func(*JobResult) `json:"-"`
}

func (j *MiningJob) GetID() string {
	return j.ID
}

func (j *MiningJob) GetPriority() JobPriority {
	return JobPriority(atomic.LoadInt32((*int32)(&j.Priority)))
}

func (j *MiningJob) GetCreationTime() time.Time {
	return j.CreatedAt
}

func (j *MiningJob) SetPriority(p JobPriority) {
	atomic.StoreInt32((*int32)(&j.Priority), int32(p))
}

func (j *MiningJob) IncRetryCount() {
	atomic.AddInt64(&j.RetryCount, 1)
}

// JobResult contains the result of a mining job
type JobResult struct {
	JobID     string    `json:"job_id"`
	Success   bool      `json:"success"`
	Nonce     uint64    `json:"nonce"`
	Hash      []byte    `json:"hash"`
	Timestamp time.Time `json:"timestamp"`
}

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
	Valid       bool          `json:"valid"`
	IsBlock     bool          `json:"is_block"`
	Reason      string        `json:"reason"`
	Difficulty  uint64        `json:"difficulty"`
	Hash        []byte        `json:"hash,omitempty"`
	ProcessTime time.Duration `json:"process_time,omitempty"`
}

// AlgorithmConfig represents a mining algorithm with profitability data
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

	// Auto-switching configuration
	AutoSwitch      bool          `json:"auto_switch"`
	SwitchInterval  time.Duration `json:"switch_interval"`
	ProfitThreshold float64       `json:"profit_threshold"`

	// Hardware preferences
	PreferCPU bool `json:"prefer_cpu"`
	PreferGPU bool `json:"prefer_gpu"`
	PreferASIC bool `json:"prefer_asic"`

	// Performance tuning
	BenchmarkOnStart bool `json:"benchmark_on_start"`
	OptimizeMemory   bool `json:"optimize_memory"`
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
	Rejected   uint64         `json:"rejected"`
	InProgress int32          `json:"in_progress"`
	Active     int            `json:"active"`
	QueueSizes    map[string]int `json:"queue_sizes"`
	Pending       uint64         `json:"pending"`
	AvgWaitTime   time.Duration  `json:"avg_wait_time"`
	MaxQueueDepth uint64         `json:"max_queue_depth"`
}

// AlgoStats tracks algorithm performance
type AlgoStats struct {
	TotalHashes   uint64        `json:"total_hashes"`
	TotalShares   uint64        `json:"total_shares"`
	TotalTime     time.Duration `json:"total_time"`
	LastHashRate  uint64        `json:"last_hash_rate"`
	Profitability float64       `json:"profitability"`
}

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

// Work represents a mining job for hardware
type Work struct {
	JobID       string
	Data        []byte
	Target      []byte
	Algorithm   AlgorithmType
	Height      uint64
	Timestamp   uint32
	BlockHeader []byte
}

// OptimizedConfig holds hardware-specific optimization settings
type OptimizedConfig struct {
	// Future settings for performance tuning
}

// EngineStatus represents engine status
type EngineStatus struct {
	Running   bool          `json:"running"`
	Algorithm AlgorithmType `json:"algorithm"`
	Pool      string        `json:"pool"`
	Wallet    string        `json:"wallet"`
	Uptime    time.Duration `json:"uptime"`
}

// MinShareDifficulty represents minimum share difficulty
const MinShareDifficulty = 1000

// StatsSnapshot represents a point-in-time stats snapshot
type StatsSnapshot struct {
	Timestamp time.Time `json:"timestamp"`
	Stats     Stats     `json:"stats"`
}

// ASICDevice represents an ASIC mining device
type ASICDevice struct {
	ID           string  `json:"id"`
	Model        string  `json:"model"`
	Algorithm    string  `json:"algorithm"`
	HashRate     uint64  `json:"hash_rate"`
	PowerUsage   float64 `json:"power_usage"`
}

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

