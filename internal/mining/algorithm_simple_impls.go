package mining

import (
	"crypto/sha256"
	"encoding/binary"
	"math/big"

	"go.uber.org/zap"
)

// simpleAlgorithm is a lightweight implementation of AlgorithmInstance
// providing basic hashing/validation and no-op lifecycle.
type simpleAlgorithm struct {
	name      string
	version   string
	logger    *zap.Logger
}

func (a *simpleAlgorithm) Name() string { return a.name }
func (a *simpleAlgorithm) Version() string { return a.version }
func (a *simpleAlgorithm) Info() *AlgorithmInfo { return &AlgorithmInfo{Name: a.name, Version: a.version} }

func (a *simpleAlgorithm) Hash(data []byte) []byte {
	// Default to single SHA256; specific algos can override via distinct types if needed
	s := sha256.Sum256(data)
	return s[:]
}

func (a *simpleAlgorithm) HashWithNonce(header []byte, nonce uint32) []byte {
	buf := make([]byte, 0, len(header)+4)
	buf = append(buf, header...)
	n := make([]byte, 4)
	binary.LittleEndian.PutUint32(n, nonce)
	buf = append(buf, n...)
	return a.Hash(buf)
}

func (a *simpleAlgorithm) ValidateHash(hash []byte, target []byte) bool {
	if len(target) == 0 || len(hash) == 0 {
		return false
	}
	h := new(big.Int).SetBytes(hash)
	t := new(big.Int).SetBytes(target)
	return h.Cmp(t) <= 0
}

func (a *simpleAlgorithm) GenerateWork(template *BlockTemplate) (*Work, error) {
	// Assemble a minimal 80-byte header (PrevHash[32] | MerkleRoot[32] | Timestamp[4] | Bits[4] | Nonce[4])
	header := make([]byte, 0, 80)
	header = append(header, template.PrevHash[:]...)
	header = append(header, template.MerkleRoot[:]...)
	// Timestamp (uint32 little-endian)
	ts := make([]byte, 4)
	binary.LittleEndian.PutUint32(ts, uint32(template.Timestamp))
	header = append(header, ts...)
	// Bits
	bb := make([]byte, 4)
	binary.LittleEndian.PutUint32(bb, template.Bits)
	header = append(header, bb...)
	// Nonce (start at 0)
	header = append(header, 0, 0, 0, 0)

	w := &Work{
		JobID:       "",
		Data:        header,
		Target:      nil,
		Algorithm:   SHA256D, // default; callers can ignore
		Height:      template.Height,
		Timestamp:   uint32(template.Timestamp),
		BlockHeader: header,
	}
	return w, nil
}

func (a *simpleAlgorithm) GetHashRate() uint64 { return 0 }
func (a *simpleAlgorithm) SupportsHardwareAcceleration() bool { return false }
func (a *simpleAlgorithm) GetOptimalBatchSize() int { return 1024 }
func (a *simpleAlgorithm) Start() error { return nil }
func (a *simpleAlgorithm) Stop() error  { return nil }

// Constructors expected by UnifiedAlgorithmManager.registerDefaultAlgorithms

func NewSHA256dAlgorithm(logger *zap.Logger) (AlgorithmInstance, error) {
	return &simpleAlgorithm{name: "sha256d", version: "0.1.0", logger: logger}, nil
}

func NewEthashAlgorithm(logger *zap.Logger) (AlgorithmInstance, error) {
	return &simpleAlgorithm{name: "ethash", version: "0.1.0", logger: logger}, nil
}

func NewRandomXAlgorithm(logger *zap.Logger) (AlgorithmInstance, error) {
	return &simpleAlgorithm{name: "randomx", version: "0.1.0", logger: logger}, nil
}

func NewScryptAlgorithm(logger *zap.Logger) (AlgorithmInstance, error) {
	return &simpleAlgorithm{name: "scrypt", version: "0.1.0", logger: logger}, nil
}

func NewKawPowAlgorithm(logger *zap.Logger) (AlgorithmInstance, error) {
	return &simpleAlgorithm{name: "kawpow", version: "0.1.0", logger: logger}, nil
}
