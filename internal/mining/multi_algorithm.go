package mining

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"

	"go.uber.org/zap"
	"golang.org/x/crypto/scrypt"
)

// AlgorithmEngine interface for algorithm-specific mining engines
type AlgorithmEngine interface {
	GetAlgorithm() string
	CalculateHash(data []byte) ([]byte, error)
	ValidateHash(hash []byte, target []byte) bool
	GetHashrate() float64
}

// EngineRegistry manages mining engines for different algorithms
var (
	engineRegistry = make(map[string]AlgorithmEngine)
	engineMu       sync.RWMutex
)

// RegisterAlgorithmEngine registers a mining engine for an algorithm
func RegisterAlgorithmEngine(algorithm string, engine AlgorithmEngine) {
	engineMu.Lock()
	defer engineMu.Unlock()
	engineRegistry[algorithm] = engine
}

// GetAlgorithmEngine returns the mining engine for the specified algorithm
func GetAlgorithmEngine(algorithm string) AlgorithmEngine {
	engineMu.RLock()
	defer engineMu.RUnlock()
	return engineRegistry[algorithm]
}

// SHA256Engine implements AlgorithmEngine for SHA256 algorithm
type SHA256Engine struct {
	logger *zap.Logger
}

func NewSHA256Engine(logger *zap.Logger) *SHA256Engine {
	return &SHA256Engine{logger: logger}
}

func (e *SHA256Engine) GetAlgorithm() string {
	return "sha256"
}

func (e *SHA256Engine) CalculateHash(data []byte) ([]byte, error) {
	hash := sha256.Sum256(data)
	return hash[:], nil
}

func (e *SHA256Engine) ValidateHash(hash []byte, target []byte) bool {
	for i := range target {
		if i >= len(hash) {
			return false
		}
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return true
}

func (e *SHA256Engine) GetHashrate() float64 {
	return 0 // To be implemented with actual stats
}

// SHA256dEngine implements AlgorithmEngine for double SHA256 (Bitcoin)
type SHA256dEngine struct {
	*SHA256Engine
}

func NewSHA256dEngine(logger *zap.Logger) *SHA256dEngine {
	return &SHA256dEngine{
		SHA256Engine: NewSHA256Engine(logger),
	}
}

func (e *SHA256dEngine) GetAlgorithm() string {
	return "sha256d"
}

func (e *SHA256dEngine) CalculateHash(data []byte) ([]byte, error) {
	hash1 := sha256.Sum256(data)
	hash2 := sha256.Sum256(hash1[:])
	return hash2[:], nil
}

// ScryptEngine implements AlgorithmEngine for Scrypt algorithm
type ScryptEngine struct {
	logger *zap.Logger
	n, r, p int
	keyLen int
}

func NewScryptEngine(logger *zap.Logger) *ScryptEngine {
	return &ScryptEngine{
		logger: logger,
		n:      1024,   // Litecoin parameters
		r:      1,
		p:      1,
		keyLen: 32,
	}
}

func (e *ScryptEngine) GetAlgorithm() string {
	return "scrypt"
}

func (e *ScryptEngine) CalculateHash(data []byte) ([]byte, error) {
	return scrypt.Key(data, data, e.n, e.r, e.p, e.keyLen)
}

func (e *ScryptEngine) ValidateHash(hash []byte, target []byte) bool {
	for i := range target {
		if i >= len(hash) {
			return false
		}
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return true
}

func (e *ScryptEngine) GetHashrate() float64 {
	return 0
}

// EthashEngine implements AlgorithmEngine for Ethash algorithm (simplified)
type EthashEngine struct {
	logger *zap.Logger
}

func NewEthashEngine(logger *zap.Logger) *EthashEngine {
	return &EthashEngine{logger: logger}
}

func (e *EthashEngine) GetAlgorithm() string {
	return "ethash"
}

func (e *EthashEngine) CalculateHash(data []byte) ([]byte, error) {
	// Simplified version - real Ethash requires DAG
	hash := sha256.Sum256(data)
	return hash[:], nil
}

func (e *EthashEngine) ValidateHash(hash []byte, target []byte) bool {
	for i := range target {
		if i >= len(hash) {
			return false
		}
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return true
}

func (e *EthashEngine) GetHashrate() float64 {
	return 0
}

// InitializeAlgorithms registers all supported mining algorithms
func InitializeAlgorithms(logger *zap.Logger) {
	// Register SHA256 engines
	RegisterAlgorithmEngine("sha256", NewSHA256Engine(logger))
	RegisterAlgorithmEngine("sha256d", NewSHA256dEngine(logger))
	
	// Register Scrypt engine
	RegisterAlgorithmEngine("scrypt", NewScryptEngine(logger))
	
	// Register Ethash engine
	ethashEngine := NewEthashEngine(logger)
	RegisterAlgorithmEngine("ethash", ethashEngine)
	RegisterAlgorithmEngine("etchash", ethashEngine) // Ethereum Classic uses same engine
}

// DifficultyToTarget converts difficulty to target bytes
func DifficultyToTarget(difficulty float64) []byte {
	target := make([]byte, 32)
	
	if difficulty <= 0 {
		difficulty = 1
	}
	
	// Simplified: set leading zeros based on difficulty
	zerosCount := int(difficulty / 1000000)
	if zerosCount > 31 {
		zerosCount = 31
	}
	
	for i := 0; i < zerosCount; i++ {
		target[i] = 0
	}
	
	if zerosCount < 32 {
		target[zerosCount] = byte(256 / (1 + int(difficulty)%256))
		for i := zerosCount + 1; i < 32; i++ {
			target[i] = 0xFF
		}
	}
	
	return target
}

// TargetToDifficulty converts target bytes to difficulty
func TargetToDifficulty(target []byte) float64 {
	zeros := 0
	for _, b := range target {
		if b == 0 {
			zeros++
		} else {
			break
		}
	}
	return float64(zeros) * 1000000
}

// HexToBytes converts hex string to bytes
func HexToBytes(s string) ([]byte, error) {
	return hex.DecodeString(s)
}

// BytesToHex converts bytes to hex string
func BytesToHex(b []byte) string {
	return hex.EncodeToString(b)
}