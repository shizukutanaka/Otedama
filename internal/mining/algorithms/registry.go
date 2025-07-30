package algorithms

import (
	"fmt"
	"math/big"
	"sync"
)

// Algorithm represents a mining algorithm
type Algorithm struct {
	Name           string
	DisplayName    string
	Type           AlgorithmType
	HashFunction   HashFunc
	ValidateFunc   ValidateFunc
	DifficultyFunc DifficultyFunc
	Config         AlgorithmConfig
}

// AlgorithmType categorizes algorithms
type AlgorithmType string

const (
	TypeProofOfWork     AlgorithmType = "proof_of_work"
	TypeMemoryHard      AlgorithmType = "memory_hard"
	TypeASICResistant   AlgorithmType = "asic_resistant"
	TypeGPUOptimized    AlgorithmType = "gpu_optimized"
	TypeCPUOptimized    AlgorithmType = "cpu_optimized"
	TypeMergedMining    AlgorithmType = "merged_mining"
)

// HashFunc is the hashing function for an algorithm
type HashFunc func(data []byte, nonce uint64) ([]byte, error)

// ValidateFunc validates a hash against difficulty
type ValidateFunc func(hash []byte, difficulty uint64) bool

// DifficultyFunc calculates difficulty from target
type DifficultyFunc func(target []byte) uint64

// AlgorithmConfig contains algorithm-specific configuration
type AlgorithmConfig struct {
	// Memory requirements
	MemorySize     uint64
	MemoryHardness bool
	
	// Performance characteristics
	ThreadsPerHash int
	HashesPerNonce int
	
	// Hardware optimization
	GPUOptimized  bool
	ASICResistant bool
	CPUFriendly   bool
	
	// Additional parameters
	Params map[string]interface{}
}

// Registry manages available mining algorithms
type Registry struct {
	algorithms map[string]*Algorithm
	mu         sync.RWMutex
}

// Global algorithm registry
var defaultRegistry = NewRegistry()

// NewRegistry creates a new algorithm registry
func NewRegistry() *Registry {
	r := &Registry{
		algorithms: make(map[string]*Algorithm),
	}
	
	// Register all supported algorithms
	r.registerDefaultAlgorithms()
	
	return r
}

// registerDefaultAlgorithms registers all built-in algorithms
func (r *Registry) registerDefaultAlgorithms() {
	// SHA-256 (Bitcoin)
	r.Register(&Algorithm{
		Name:        "sha256",
		DisplayName: "SHA-256",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   false,
		},
	})
	
	// SHA-256d (Bitcoin double SHA-256)
	r.Register(&Algorithm{
		Name:        "sha256d",
		DisplayName: "SHA-256 Double",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   false,
			HashesPerNonce: 2,
		},
	})
	
	// Scrypt (Litecoin)
	r.Register(&Algorithm{
		Name:        "scrypt",
		DisplayName: "Scrypt",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     128 * 1024, // 128 KB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			Params: map[string]interface{}{
				"N": 1024,
				"r": 1,
				"p": 1,
			},
		},
	})
	
	// Ethash (Ethereum Classic)
	r.Register(&Algorithm{
		Name:        "ethash",
		DisplayName: "Ethash",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB DAG
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
		},
	})
	
	// Etchash (Ethereum Classic modified)
	r.Register(&Algorithm{
		Name:        "etchash",
		DisplayName: "Etchash",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024 * 1024, // 2 GB DAG
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// X11 (Dash)
	r.Register(&Algorithm{
		Name:        "x11",
		DisplayName: "X11",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 11, // 11 different hash functions
		},
	})
	
	// X13
	r.Register(&Algorithm{
		Name:        "x13",
		DisplayName: "X13",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 13,
		},
	})
	
	// X15
	r.Register(&Algorithm{
		Name:        "x15",
		DisplayName: "X15",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 15,
		},
	})
	
	// X16R (Ravencoin)
	r.Register(&Algorithm{
		Name:        "x16r",
		DisplayName: "X16R",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			HashesPerNonce: 16,
		},
	})
	
	// X16S
	r.Register(&Algorithm{
		Name:        "x16s",
		DisplayName: "X16S",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			HashesPerNonce: 16,
		},
	})
	
	// KawPow (Ravencoin current)
	r.Register(&Algorithm{
		Name:        "kawpow",
		DisplayName: "KawPow",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			MemorySize:     256 * 1024 * 1024, // 256 MB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Equihash (Zcash)
	r.Register(&Algorithm{
		Name:        "equihash",
		DisplayName: "Equihash",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     700 * 1024 * 1024, // 700 MB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			Params: map[string]interface{}{
				"N": 200,
				"K": 9,
			},
		},
	})
	
	// Equihash 144,5 (Bitcoin Gold)
	r.Register(&Algorithm{
		Name:        "equihash144_5",
		DisplayName: "Equihash 144,5",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024 * 1024, // 2 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			Params: map[string]interface{}{
				"N": 144,
				"K": 5,
			},
		},
	})
	
	// Equihash 192,7 (Zero)
	r.Register(&Algorithm{
		Name:        "equihash192_7",
		DisplayName: "Equihash 192,7",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     3 * 1024 * 1024 * 1024, // 3 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			Params: map[string]interface{}{
				"N": 192,
				"K": 7,
			},
		},
	})
	
	// Zhash (Equihash 144,5 modified)
	r.Register(&Algorithm{
		Name:        "zhash",
		DisplayName: "Zhash",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024 * 1024, // 2 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// CryptoNight (Original Monero)
	r.Register(&Algorithm{
		Name:        "cryptonight",
		DisplayName: "CryptoNight",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024, // 2 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// CryptoNight-R
	r.Register(&Algorithm{
		Name:        "cryptonightr",
		DisplayName: "CryptoNight-R",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024, // 2 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// RandomX (Current Monero)
	r.Register(&Algorithm{
		Name:        "randomx",
		DisplayName: "RandomX",
		Type:        TypeCPUOptimized,
		Config: AlgorithmConfig{
			MemorySize:     2 * 1024 * 1024 * 1024, // 2 GB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
			ThreadsPerHash: 1,
		},
	})
	
	// RandomARQ (Arqma)
	r.Register(&Algorithm{
		Name:        "randomarq",
		DisplayName: "RandomARQ",
		Type:        TypeCPUOptimized,
		Config: AlgorithmConfig{
			MemorySize:     256 * 1024 * 1024, // 256 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// RandomWOW (Wownero)
	r.Register(&Algorithm{
		Name:        "randomwow",
		DisplayName: "RandomWOW",
		Type:        TypeCPUOptimized,
		Config: AlgorithmConfig{
			MemorySize:     1 * 1024 * 1024 * 1024, // 1 GB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// Autolykos2 (Ergo)
	r.Register(&Algorithm{
		Name:        "autolykos2",
		DisplayName: "Autolykos2",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024, // 4 MB per hash
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Blake2s (multiple coins)
	r.Register(&Algorithm{
		Name:        "blake2s",
		DisplayName: "Blake2s",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// Blake2b
	r.Register(&Algorithm{
		Name:        "blake2b",
		DisplayName: "Blake2b",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// Blake3
	r.Register(&Algorithm{
		Name:        "blake3",
		DisplayName: "Blake3",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// Keccak (MaxCoin)
	r.Register(&Algorithm{
		Name:        "keccak",
		DisplayName: "Keccak",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// Quark
	r.Register(&Algorithm{
		Name:        "quark",
		DisplayName: "Quark",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 9, // 9 rounds of hashing
		},
	})
	
	// Qubit
	r.Register(&Algorithm{
		Name:        "qubit",
		DisplayName: "Qubit",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 5,
		},
	})
	
	// NeoScrypt
	r.Register(&Algorithm{
		Name:        "neoscrypt",
		DisplayName: "NeoScrypt",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     256 * 1024, // 256 KB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Lyra2RE
	r.Register(&Algorithm{
		Name:        "lyra2re",
		DisplayName: "Lyra2RE",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 5,
		},
	})
	
	// Lyra2REv2
	r.Register(&Algorithm{
		Name:        "lyra2rev2",
		DisplayName: "Lyra2REv2",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 6,
		},
	})
	
	// Lyra2REv3
	r.Register(&Algorithm{
		Name:        "lyra2rev3",
		DisplayName: "Lyra2REv3",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			HashesPerNonce: 5,
		},
	})
	
	// Lyra2Z
	r.Register(&Algorithm{
		Name:        "lyra2z",
		DisplayName: "Lyra2Z",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
			HashesPerNonce: 3,
		},
	})
	
	// TimeTravel10 (Bitcore)
	r.Register(&Algorithm{
		Name:        "timetravel10",
		DisplayName: "TimeTravel10",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 10,
		},
	})
	
	// C11
	r.Register(&Algorithm{
		Name:        "c11",
		DisplayName: "C11",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 11,
		},
	})
	
	// PHI1612
	r.Register(&Algorithm{
		Name:        "phi1612",
		DisplayName: "PHI1612",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 5,
		},
	})
	
	// PHI2
	r.Register(&Algorithm{
		Name:        "phi2",
		DisplayName: "PHI2",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
			HashesPerNonce: 5,
		},
	})
	
	// Skein
	r.Register(&Algorithm{
		Name:        "skein",
		DisplayName: "Skein",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// Groestl
	r.Register(&Algorithm{
		Name:        "groestl",
		DisplayName: "Groestl",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   false,
		},
	})
	
	// Myr-Groestl
	r.Register(&Algorithm{
		Name:        "myr-groestl",
		DisplayName: "Myr-Groestl",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   false,
		},
	})
	
	// HEFTY1
	r.Register(&Algorithm{
		Name:        "hefty1",
		DisplayName: "HEFTY1",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  false,
			ASICResistant: true,
			CPUFriendly:   true,
		},
	})
	
	// Argon2d
	r.Register(&Algorithm{
		Name:        "argon2d",
		DisplayName: "Argon2d",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     512 * 1024 * 1024, // 512 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
			Params: map[string]interface{}{
				"time":    1,
				"memory":  524288,
				"threads": 1,
			},
		},
	})
	
	// Argon2i
	r.Register(&Algorithm{
		Name:        "argon2i",
		DisplayName: "Argon2i",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     256 * 1024 * 1024, // 256 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
			Params: map[string]interface{}{
				"time":    1,
				"memory":  262144,
				"threads": 1,
			},
		},
	})
	
	// Argon2id
	r.Register(&Algorithm{
		Name:        "argon2id",
		DisplayName: "Argon2id",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     256 * 1024 * 1024, // 256 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
			Params: map[string]interface{}{
				"time":    1,
				"memory":  262144,
				"threads": 1,
			},
		},
	})
	
	// Yescrypt
	r.Register(&Algorithm{
		Name:        "yescrypt",
		DisplayName: "Yescrypt",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     16 * 1024 * 1024, // 16 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// YescryptR16
	r.Register(&Algorithm{
		Name:        "yescryptr16",
		DisplayName: "YescryptR16",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     64 * 1024 * 1024, // 64 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// YescryptR32
	r.Register(&Algorithm{
		Name:        "yescryptr32",
		DisplayName: "YescryptR32",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     128 * 1024 * 1024, // 128 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// Balloon Hash
	r.Register(&Algorithm{
		Name:        "balloon",
		DisplayName: "Balloon Hash",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     128 * 1024 * 1024, // 128 MB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
		},
	})
	
	// Quantum-resistant placeholder (future-proofing)
	r.Register(&Algorithm{
		Name:        "post-quantum",
		DisplayName: "Post-Quantum Hash",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB
			MemoryHardness: true,
			GPUOptimized:   false,
			ASICResistant:  true,
			CPUFriendly:    true,
			Params: map[string]interface{}{
				"lattice_dimension": 1024,
				"security_level":    256,
			},
		},
	})
	
	// MTP (Merkle Tree Proof)
	r.Register(&Algorithm{
		Name:        "mtp",
		DisplayName: "MTP",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// ProgPoW (Programmatic Proof of Work)
	r.Register(&Algorithm{
		Name:        "progpow",
		DisplayName: "ProgPoW",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB DAG
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// FiroPoW (Firo)
	r.Register(&Algorithm{
		Name:        "firopow",
		DisplayName: "FiroPoW",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB DAG
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Octopus (Conflux)
	r.Register(&Algorithm{
		Name:        "octopus",
		DisplayName: "Octopus",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     6 * 1024 * 1024 * 1024, // 6 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// BeamHashIII (Beam)
	r.Register(&Algorithm{
		Name:        "beamhash3",
		DisplayName: "BeamHash III",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			MemorySize:     3 * 1024 * 1024 * 1024, // 3 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Verthash (Vertcoin)
	r.Register(&Algorithm{
		Name:        "verthash",
		DisplayName: "Verthash",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     1200 * 1024 * 1024, // 1.2 GB data file
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Eaglesong (Nervos CKB)
	r.Register(&Algorithm{
		Name:        "eaglesong",
		DisplayName: "Eaglesong",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   false,
		},
	})
	
	// Cuckaroo29 (Grin)
	r.Register(&Algorithm{
		Name:        "cuckaroo29",
		DisplayName: "Cuckaroo29",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     6 * 1024 * 1024 * 1024, // 6 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Cuckatoo31 (Grin)
	r.Register(&Algorithm{
		Name:        "cuckatoo31",
		DisplayName: "Cuckatoo31",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     11 * 1024 * 1024 * 1024, // 11 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
		},
	})
	
	// Cuckatoo32 (Grin)
	r.Register(&Algorithm{
		Name:        "cuckatoo32",
		DisplayName: "Cuckatoo32",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     22 * 1024 * 1024 * 1024, // 22 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  false,
			CPUFriendly:    false,
		},
	})
	
	// CuckooCycle
	r.Register(&Algorithm{
		Name:        "cuckoocycle",
		DisplayName: "Cuckoo Cycle",
		Type:        TypeMemoryHard,
		Config: AlgorithmConfig{
			MemorySize:     4 * 1024 * 1024 * 1024, // 4 GB
			MemoryHardness: true,
			GPUOptimized:   true,
			ASICResistant:  true,
			CPUFriendly:    false,
		},
	})
	
	// Tensority (Bytom)
	r.Register(&Algorithm{
		Name:        "tensority",
		DisplayName: "Tensority",
		Type:        TypeASICResistant,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: true,
			CPUFriendly:   false,
		},
	})
	
	// kHeavyHash (Kaspa - 2025 high-performance algorithm)
	r.Register(&Algorithm{
		Name:        "kheavyhash",
		DisplayName: "kHeavyHash",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			MemorySize:     32 * 1024, // 32 KB per hash
			MemoryHardness: false,
			GPUOptimized:   true,
			ASICResistant:  false, // ASIC-friendly for high performance
			CPUFriendly:    false,
			ThreadsPerHash: 1,
			HashesPerNonce: 1,
			Params: map[string]interface{}{
				"matrix_size": 64,
				"keccak_f":    1600,
			},
		},
	})
	
	// SHA-3 (Ethereum 2.0 compatible)
	r.Register(&Algorithm{
		Name:        "sha3",
		DisplayName: "SHA-3",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// SHA-3-256 (Latest secure hash)
	r.Register(&Algorithm{
		Name:        "sha3-256",
		DisplayName: "SHA-3-256",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
	
	// SHA-3-512 (Maximum security)
	r.Register(&Algorithm{
		Name:        "sha3-512",
		DisplayName: "SHA-3-512",
		Type:        TypeProofOfWork,
		Config: AlgorithmConfig{
			GPUOptimized:  true,
			ASICResistant: false,
			CPUFriendly:   true,
		},
	})
}

// Register adds a new algorithm to the registry
func (r *Registry) Register(algo *Algorithm) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	if _, exists := r.algorithms[algo.Name]; exists {
		return fmt.Errorf("algorithm %s already registered", algo.Name)
	}
	
	r.algorithms[algo.Name] = algo
	return nil
}

// Get retrieves an algorithm by name
func (r *Registry) Get(name string) (*Algorithm, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	algo, exists := r.algorithms[name]
	if !exists {
		return nil, fmt.Errorf("algorithm %s not found", name)
	}
	
	return algo, nil
}

// Common validation and difficulty functions

// sha256Validate validates a hash against a difficulty target
func sha256Validate(hash []byte, difficulty uint64) bool {
	if len(hash) != 32 {
		return false
	}
	
	// Convert hash to big.Int
	hashInt := new(big.Int).SetBytes(hash)
	
	// Calculate target from difficulty
	// Target = 2^256 / difficulty
	target := new(big.Int).Exp(big.NewInt(2), big.NewInt(256), nil)
	target.Div(target, new(big.Int).SetUint64(difficulty))
	
	// Hash must be less than target
	return hashInt.Cmp(target) < 0
}

// calculateDifficulty calculates difficulty from a target
func calculateDifficulty(target []byte) uint64 {
	if len(target) != 32 {
		return 1
	}
	
	// Convert target to big.Int
	targetInt := new(big.Int).SetBytes(target)
	
	// Avoid division by zero
	if targetInt.Sign() == 0 {
		return 1
	}
	
	// Difficulty = 2^256 / target
	max := new(big.Int).Exp(big.NewInt(2), big.NewInt(256), nil)
	diff := new(big.Int).Div(max, targetInt)
	
	// Cap at max uint64
	if diff.BitLen() > 64 {
		return ^uint64(0) // max uint64
	}
	
	return diff.Uint64()
}

// List returns all registered algorithms
func (r *Registry) List() []*Algorithm {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	algorithms := make([]*Algorithm, 0, len(r.algorithms))
	for _, algo := range r.algorithms {
		algorithms = append(algorithms, algo)
	}
	
	return algorithms
}

// ListByType returns algorithms of a specific type
func (r *Registry) ListByType(algoType AlgorithmType) []*Algorithm {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	var algorithms []*Algorithm
	for _, algo := range r.algorithms {
		if algo.Type == algoType {
			algorithms = append(algorithms, algo)
		}
	}
	
	return algorithms
}

// ListGPUOptimized returns GPU-optimized algorithms
func (r *Registry) ListGPUOptimized() []*Algorithm {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	var algorithms []*Algorithm
	for _, algo := range r.algorithms {
		if algo.Config.GPUOptimized {
			algorithms = append(algorithms, algo)
		}
	}
	
	return algorithms
}

// ListCPUFriendly returns CPU-friendly algorithms
func (r *Registry) ListCPUFriendly() []*Algorithm {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	var algorithms []*Algorithm
	for _, algo := range r.algorithms {
		if algo.Config.CPUFriendly {
			algorithms = append(algorithms, algo)
		}
	}
	
	return algorithms
}

// ListASICResistant returns ASIC-resistant algorithms
func (r *Registry) ListASICResistant() []*Algorithm {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	var algorithms []*Algorithm
	for _, algo := range r.algorithms {
		if algo.Config.ASICResistant {
			algorithms = append(algorithms, algo)
		}
	}
	
	return algorithms
}

// Global registry functions

// Register adds an algorithm to the global registry
func Register(algo *Algorithm) error {
	return defaultRegistry.Register(algo)
}

// Get retrieves an algorithm from the global registry
func Get(name string) (*Algorithm, error) {
	return defaultRegistry.Get(name)
}

// List returns all algorithms from the global registry
func List() []*Algorithm {
	return defaultRegistry.List()
}

// ListByType returns algorithms of a specific type from the global registry
func ListByType(algoType AlgorithmType) []*Algorithm {
	return defaultRegistry.ListByType(algoType)
}

// ListGPUOptimized returns GPU-optimized algorithms from the global registry
func ListGPUOptimized() []*Algorithm {
	return defaultRegistry.ListGPUOptimized()
}

// ListCPUFriendly returns CPU-friendly algorithms from the global registry
func ListCPUFriendly() []*Algorithm {
	return defaultRegistry.ListCPUFriendly()
}

// ListASICResistant returns ASIC-resistant algorithms from the global registry
func ListASICResistant() []*Algorithm {
	return defaultRegistry.ListASICResistant()
}