package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"math/big"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ZKP (Schnorr) protocol parameters - must match client-side
var (
	p, _ = new(big.Int).SetString("23992346986434786549598124020385574583538633535221234567890123456789012345678901234567890123456789", 10)
	g = big.NewInt(5)
)

// ZKPManager handles the server-side logic for Zero-Knowledge Proof authentication.
type ZKPManager struct {
	logger         *zap.Logger
	userPublicKeys map[string]*big.Int // In-memory store for user public keys (username -> publicKey)
	challenges     map[string]string   // In-memory store for active challenges (username -> challenge)
	mu             sync.RWMutex
}

// NewZKPManager creates and returns a new ZKPManager.
func NewZKPManager(logger *zap.Logger) *ZKPManager {
	return &ZKPManager{
		logger:         logger,
		userPublicKeys: make(map[string]*big.Int),
		challenges:     make(map[string]string),
	}
}

// RegisterPublicKey stores a user's public key. 
// In a real application, this would be persisted in a database.
func (m *ZKPManager) RegisterPublicKey(username string, publicKey *big.Int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.userPublicKeys[username] = publicKey
	m.logger.Info("Registered ZKP public key for user", zap.String("username", username))
}

// GenerateChallenge creates, stores, and returns a new challenge for a user.
func (m *ZKPManager) GenerateChallenge(username string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Ensure user has a registered public key
	if _, ok := m.userPublicKeys[username]; !ok {
		return "", fmt.Errorf("no public key registered for user: %s", username)
	}

	b := make([]byte, 32)
	_, err := rand.Read(b)
	if err != nil {
		return "", fmt.Errorf("failed to generate random challenge: %w", err)
	}

	challenge := fmt.Sprintf("%x-%d", b, time.Now().UnixNano())
	m.challenges[username] = challenge

	// Set a timeout to automatically clear the challenge
	go func() {
		time.Sleep(2 * time.Minute)
		m.mu.Lock()
		if m.challenges[username] == challenge {
			delete(m.challenges, username)
		}
		m.mu.Unlock()
	}()

	return challenge, nil
}

// VerifyProof verifies the ZKP proof provided by the client.
func (m *ZKPManager) VerifyProof(username string, commitment, proof *big.Int) (bool, error) {
	m.mu.Lock()
	challenge, challengeOk := m.challenges[username]
	publicKey, pkOk := m.userPublicKeys[username]
	// The challenge is single-use, so delete it immediately.
	delete(m.challenges, username)
	m.mu.Unlock()

	if !challengeOk {
		return false, fmt.Errorf("no active challenge found for user, it may have expired")
	}
	if !pkOk {
		return false, fmt.Errorf("no public key registered for user")
	}

	// 1. Re-calculate the hash (c = H(t, M))
	hash := sha256.Sum256([]byte(commitment.String() + challenge))
	c := new(big.Int).SetBytes(hash[:])

	// 2. Verify the proof by checking if g^s == y^c * t (mod p)
	// Left side: g^s mod p
	left := new(big.Int).Exp(g, proof, p)

	// Right side: (y^c * t) mod p
	yc := new(big.Int).Exp(publicKey, c, p)
	right := new(big.Int).Mul(yc, commitment)
	right.Mod(right, p)

	if left.Cmp(right) == 0 {
		return true, nil // Proof is valid
	}

	return false, nil // Proof is invalid
}
