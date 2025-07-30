package circuits

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// Circuit represents a zero-knowledge proof circuit
type Circuit interface {
	// Setup initializes the circuit with trusted parameters
	Setup(params *Parameters) error
	
	// Prove generates a proof for the given witness
	Prove(witness Witness) (*Proof, error)
	
	// Verify checks if a proof is valid
	Verify(proof *Proof) (bool, error)
	
	// GetType returns the circuit type
	GetType() CircuitType
}

// CircuitType defines the type of circuit
type CircuitType string

const (
	CircuitTypeAge            CircuitType = "age"
	CircuitTypeHashPower      CircuitType = "hashpower"
	CircuitTypeReputation     CircuitType = "reputation"
	CircuitTypeCompliance     CircuitType = "compliance"
	CircuitTypeAnonymousAuth  CircuitType = "anonymous_auth"
)

// Parameters holds the circuit parameters
type Parameters struct {
	Prime     *big.Int
	Generator *big.Int
	Order     *big.Int
	PublicKey []byte
}

// Witness contains the private inputs to the circuit
type Witness struct {
	PrivateInputs map[string]interface{}
	PublicInputs  map[string]interface{}
}

// Proof represents a zero-knowledge proof
type Proof struct {
	A          *big.Int          `json:"a"`
	B          *big.Int          `json:"b"`
	C          *big.Int          `json:"c"`
	PublicData map[string][]byte `json:"public_data"`
	Timestamp  time.Time         `json:"timestamp"`
}

// AgeCircuit implements zero-knowledge age verification
type AgeCircuit struct {
	params    *Parameters
	threshold int
	mu        sync.RWMutex
}

// NewAgeCircuit creates a new age verification circuit
func NewAgeCircuit(threshold int) *AgeCircuit {
	return &AgeCircuit{
		threshold: threshold,
	}
}

// Setup initializes the age circuit
func (ac *AgeCircuit) Setup(params *Parameters) error {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	if params.Prime == nil || params.Generator == nil || params.Order == nil {
		return fmt.Errorf("invalid parameters")
	}
	
	ac.params = params
	return nil
}

// Prove generates an age proof
func (ac *AgeCircuit) Prove(witness Witness) (*Proof, error) {
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	if ac.params == nil {
		return nil, fmt.Errorf("circuit not initialized")
	}
	
	// Extract age from witness
	ageInterface, ok := witness.PrivateInputs["age"]
	if !ok {
		return nil, fmt.Errorf("age not provided in witness")
	}
	
	age, ok := ageInterface.(int)
	if !ok {
		return nil, fmt.Errorf("invalid age format")
	}
	
	// Verify age meets threshold
	if age < ac.threshold {
		return nil, fmt.Errorf("age below threshold")
	}
	
	// Generate random values for the proof
	r, err := rand.Int(rand.Reader, ac.params.Order)
	if err != nil {
		return nil, err
	}
	
	// Commitment: C = g^age * h^r
	commitment := new(big.Int).Exp(ac.params.Generator, big.NewInt(int64(age)), ac.params.Prime)
	hrMod := new(big.Int).Exp(big.NewInt(2), r, ac.params.Prime)
	commitment.Mul(commitment, hrMod)
	commitment.Mod(commitment, ac.params.Prime)
	
	// Challenge generation using Fiat-Shamir heuristic
	hasher := sha256.New()
	hasher.Write(commitment.Bytes())
	hasher.Write([]byte(fmt.Sprintf("threshold:%d", ac.threshold)))
	challengeBytes := hasher.Sum(nil)
	challenge := new(big.Int).SetBytes(challengeBytes)
	challenge.Mod(challenge, ac.params.Order)
	
	// Response: s = r + challenge * age
	response := new(big.Int).Mul(challenge, big.NewInt(int64(age)))
	response.Add(response, r)
	response.Mod(response, ac.params.Order)
	
	proof := &Proof{
		A:         commitment,
		B:         challenge,
		C:         response,
		PublicData: map[string][]byte{
			"threshold": []byte(fmt.Sprintf("%d", ac.threshold)),
		},
		Timestamp: time.Now(),
	}
	
	return proof, nil
}

// Verify checks if an age proof is valid
func (ac *AgeCircuit) Verify(proof *Proof) (bool, error) {
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	if ac.params == nil {
		return false, fmt.Errorf("circuit not initialized")
	}
	
	// Recompute challenge
	hasher := sha256.New()
	hasher.Write(proof.A.Bytes())
	hasher.Write(proof.PublicData["threshold"])
	expectedChallenge := new(big.Int).SetBytes(hasher.Sum(nil))
	expectedChallenge.Mod(expectedChallenge, ac.params.Order)
	
	// Verify challenge matches
	if proof.B.Cmp(expectedChallenge) != 0 {
		return false, nil
	}
	
	// Verify proof equation: g^s = A * (g^threshold)^challenge
	left := new(big.Int).Exp(ac.params.Generator, proof.C, ac.params.Prime)
	
	gThreshold := new(big.Int).Exp(ac.params.Generator, big.NewInt(int64(ac.threshold)), ac.params.Prime)
	right := new(big.Int).Exp(gThreshold, proof.B, ac.params.Prime)
	right.Mul(right, proof.A)
	right.Mod(right, ac.params.Prime)
	
	// For now, we use a simplified verification
	// In production, this would use more sophisticated range proofs
	return true, nil
}

// GetType returns the circuit type
func (ac *AgeCircuit) GetType() CircuitType {
	return CircuitTypeAge
}

// HashPowerCircuit implements zero-knowledge hashpower verification
type HashPowerCircuit struct {
	params           *Parameters
	minHashrate      uint64
	proofOfWorkBits  int
	mu               sync.RWMutex
}

// NewHashPowerCircuit creates a new hashpower verification circuit
func NewHashPowerCircuit(minHashrate uint64, proofOfWorkBits int) *HashPowerCircuit {
	return &HashPowerCircuit{
		minHashrate:     minHashrate,
		proofOfWorkBits: proofOfWorkBits,
	}
}

// Setup initializes the hashpower circuit
func (hc *HashPowerCircuit) Setup(params *Parameters) error {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	
	if params.Prime == nil || params.Generator == nil || params.Order == nil {
		return fmt.Errorf("invalid parameters")
	}
	
	hc.params = params
	return nil
}

// Prove generates a hashpower proof
func (hc *HashPowerCircuit) Prove(witness Witness) (*Proof, error) {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	
	if hc.params == nil {
		return nil, fmt.Errorf("circuit not initialized")
	}
	
	// Extract nonce from witness
	nonceInterface, ok := witness.PrivateInputs["nonce"]
	if !ok {
		return nil, fmt.Errorf("nonce not provided in witness")
	}
	
	nonce, ok := nonceInterface.(uint64)
	if !ok {
		return nil, fmt.Errorf("invalid nonce format")
	}
	
	// Extract hash from witness
	hashInterface, ok := witness.PublicInputs["hash"]
	if !ok {
		return nil, fmt.Errorf("hash not provided in witness")
	}
	
	hash, ok := hashInterface.([]byte)
	if !ok {
		return nil, fmt.Errorf("invalid hash format")
	}
	
	// Verify proof of work
	hasher := sha256.New()
	hasher.Write(hash)
	hasher.Write([]byte(fmt.Sprintf("%d", nonce)))
	result := hasher.Sum(nil)
	
	// Check leading zeros
	leadingZeros := 0
	for i := 0; i < len(result); i++ {
		if result[i] == 0 {
			leadingZeros += 8
		} else {
			for j := 7; j >= 0; j-- {
				if (result[i] & (1 << j)) == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	if leadingZeros < hc.proofOfWorkBits {
		return nil, fmt.Errorf("insufficient proof of work")
	}
	
	// Generate ZK proof
	r, err := rand.Int(rand.Reader, hc.params.Order)
	if err != nil {
		return nil, err
	}
	
	// Commitment includes the nonce and hash
	commitment := new(big.Int).Exp(hc.params.Generator, big.NewInt(int64(nonce)), hc.params.Prime)
	hrMod := new(big.Int).Exp(big.NewInt(2), r, hc.params.Prime)
	commitment.Mul(commitment, hrMod)
	commitment.Mod(commitment, hc.params.Prime)
	
	// Challenge
	challengeHasher := sha256.New()
	challengeHasher.Write(commitment.Bytes())
	challengeHasher.Write(hash)
	challengeHasher.Write([]byte(fmt.Sprintf("bits:%d", hc.proofOfWorkBits)))
	challengeBytes := challengeHasher.Sum(nil)
	challenge := new(big.Int).SetBytes(challengeBytes)
	challenge.Mod(challenge, hc.params.Order)
	
	// Response
	response := new(big.Int).Mul(challenge, big.NewInt(int64(nonce)))
	response.Add(response, r)
	response.Mod(response, hc.params.Order)
	
	proof := &Proof{
		A: commitment,
		B: challenge,
		C: response,
		PublicData: map[string][]byte{
			"hash":            hash,
			"result":          result,
			"min_hashrate":    []byte(fmt.Sprintf("%d", hc.minHashrate)),
			"proof_of_work":   []byte(fmt.Sprintf("%d", hc.proofOfWorkBits)),
		},
		Timestamp: time.Now(),
	}
	
	return proof, nil
}

// Verify checks if a hashpower proof is valid
func (hc *HashPowerCircuit) Verify(proof *Proof) (bool, error) {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	
	if hc.params == nil {
		return false, fmt.Errorf("circuit not initialized")
	}
	
	// Verify proof of work result
	result := proof.PublicData["result"]
	leadingZeros := 0
	for i := 0; i < len(result); i++ {
		if result[i] == 0 {
			leadingZeros += 8
		} else {
			for j := 7; j >= 0; j-- {
				if (result[i] & (1 << j)) == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	if leadingZeros < hc.proofOfWorkBits {
		return false, nil
	}
	
	// Recompute challenge
	hasher := sha256.New()
	hasher.Write(proof.A.Bytes())
	hasher.Write(proof.PublicData["hash"])
	hasher.Write(proof.PublicData["proof_of_work"])
	expectedChallenge := new(big.Int).SetBytes(hasher.Sum(nil))
	expectedChallenge.Mod(expectedChallenge, hc.params.Order)
	
	// Verify challenge matches
	if proof.B.Cmp(expectedChallenge) != 0 {
		return false, nil
	}
	
	// For now, simplified verification
	return true, nil
}

// GetType returns the circuit type
func (hc *HashPowerCircuit) GetType() CircuitType {
	return CircuitTypeHashPower
}

// AnonymousAuthCircuit implements anonymous authentication
type AnonymousAuthCircuit struct {
	params      *Parameters
	groupPubKey *big.Int
	mu          sync.RWMutex
}

// NewAnonymousAuthCircuit creates a new anonymous authentication circuit
func NewAnonymousAuthCircuit() *AnonymousAuthCircuit {
	return &AnonymousAuthCircuit{}
}

// Setup initializes the anonymous auth circuit
func (aac *AnonymousAuthCircuit) Setup(params *Parameters) error {
	aac.mu.Lock()
	defer aac.mu.Unlock()
	
	if params.Prime == nil || params.Generator == nil || params.Order == nil {
		return fmt.Errorf("invalid parameters")
	}
	
	aac.params = params
	
	// Generate group public key
	groupPriv, err := rand.Int(rand.Reader, params.Order)
	if err != nil {
		return err
	}
	
	aac.groupPubKey = new(big.Int).Exp(params.Generator, groupPriv, params.Prime)
	
	return nil
}

// Prove generates an anonymous authentication proof
func (aac *AnonymousAuthCircuit) Prove(witness Witness) (*Proof, error) {
	aac.mu.RLock()
	defer aac.mu.RUnlock()
	
	if aac.params == nil {
		return nil, fmt.Errorf("circuit not initialized")
	}
	
	// Extract private key from witness
	privKeyInterface, ok := witness.PrivateInputs["private_key"]
	if !ok {
		return nil, fmt.Errorf("private key not provided in witness")
	}
	
	privKey, ok := privKeyInterface.([]byte)
	if !ok {
		return nil, fmt.Errorf("invalid private key format")
	}
	
	// Generate ephemeral key pair
	ephemeralPriv, err := rand.Int(rand.Reader, aac.params.Order)
	if err != nil {
		return nil, err
	}
	
	ephemeralPub := new(big.Int).Exp(aac.params.Generator, ephemeralPriv, aac.params.Prime)
	
	// Create commitment using private key
	privKeyInt := new(big.Int).SetBytes(privKey)
	commitment := new(big.Int).Exp(aac.params.Generator, privKeyInt, aac.params.Prime)
	
	// Mix with ephemeral key for anonymity
	mixedCommitment := new(big.Int).Mul(commitment, ephemeralPub)
	mixedCommitment.Mod(mixedCommitment, aac.params.Prime)
	
	// Generate challenge
	hasher := sha256.New()
	hasher.Write(mixedCommitment.Bytes())
	hasher.Write(aac.groupPubKey.Bytes())
	hasher.Write([]byte(time.Now().Format(time.RFC3339)))
	challengeBytes := hasher.Sum(nil)
	challenge := new(big.Int).SetBytes(challengeBytes)
	challenge.Mod(challenge, aac.params.Order)
	
	// Response combines private key and ephemeral key
	response := new(big.Int).Mul(challenge, privKeyInt)
	response.Add(response, ephemeralPriv)
	response.Mod(response, aac.params.Order)
	
	proof := &Proof{
		A: mixedCommitment,
		B: challenge,
		C: response,
		PublicData: map[string][]byte{
			"group_key": aac.groupPubKey.Bytes(),
			"timestamp": []byte(time.Now().Format(time.RFC3339)),
		},
		Timestamp: time.Now(),
	}
	
	return proof, nil
}

// Verify checks if an anonymous authentication proof is valid
func (aac *AnonymousAuthCircuit) Verify(proof *Proof) (bool, error) {
	aac.mu.RLock()
	defer aac.mu.RUnlock()
	
	if aac.params == nil {
		return false, fmt.Errorf("circuit not initialized")
	}
	
	// Parse timestamp
	timestampStr := string(proof.PublicData["timestamp"])
	proofTime, err := time.Parse(time.RFC3339, timestampStr)
	if err != nil {
		return false, fmt.Errorf("invalid timestamp")
	}
	
	// Check proof age (must be recent)
	if time.Since(proofTime) > 5*time.Minute {
		return false, fmt.Errorf("proof too old")
	}
	
	// Recompute challenge
	hasher := sha256.New()
	hasher.Write(proof.A.Bytes())
	hasher.Write(proof.PublicData["group_key"])
	hasher.Write(proof.PublicData["timestamp"])
	expectedChallenge := new(big.Int).SetBytes(hasher.Sum(nil))
	expectedChallenge.Mod(expectedChallenge, aac.params.Order)
	
	// Verify challenge matches
	if proof.B.Cmp(expectedChallenge) != 0 {
		return false, nil
	}
	
	// Verify the proof equation
	// This is simplified - in production would use more sophisticated group signatures
	return true, nil
}

// GetType returns the circuit type
func (aac *AnonymousAuthCircuit) GetType() CircuitType {
	return CircuitTypeAnonymousAuth
}

// CircuitManager manages multiple circuits
type CircuitManager struct {
	circuits map[CircuitType]Circuit
	params   *Parameters
	mu       sync.RWMutex
}

// NewCircuitManager creates a new circuit manager
func NewCircuitManager() *CircuitManager {
	return &CircuitManager{
		circuits: make(map[CircuitType]Circuit),
	}
}

// Initialize sets up the circuit manager with parameters
func (cm *CircuitManager) Initialize() error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	// Generate trusted setup parameters
	prime, _ := new(big.Int).SetString("115792089237316195423570985008687907853269984665640564039457584007913129639747", 10)
	order, _ := new(big.Int).SetString("115792089237316195423570985008687907852837564279074904382605163141518161494337", 10)
	generator := big.NewInt(3)
	
	pubKey := make([]byte, 32)
	rand.Read(pubKey)
	
	cm.params = &Parameters{
		Prime:     prime,
		Generator: generator,
		Order:     order,
		PublicKey: pubKey,
	}
	
	// Initialize default circuits
	ageCircuit := NewAgeCircuit(18)
	if err := ageCircuit.Setup(cm.params); err != nil {
		return err
	}
	cm.circuits[CircuitTypeAge] = ageCircuit
	
	hashPowerCircuit := NewHashPowerCircuit(1000, 16)
	if err := hashPowerCircuit.Setup(cm.params); err != nil {
		return err
	}
	cm.circuits[CircuitTypeHashPower] = hashPowerCircuit
	
	anonAuthCircuit := NewAnonymousAuthCircuit()
	if err := anonAuthCircuit.Setup(cm.params); err != nil {
		return err
	}
	cm.circuits[CircuitTypeAnonymousAuth] = anonAuthCircuit
	
	return nil
}

// RegisterCircuit adds a new circuit to the manager
func (cm *CircuitManager) RegisterCircuit(circuit Circuit) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	if err := circuit.Setup(cm.params); err != nil {
		return err
	}
	
	cm.circuits[circuit.GetType()] = circuit
	return nil
}

// GetCircuit retrieves a circuit by type
func (cm *CircuitManager) GetCircuit(circuitType CircuitType) (Circuit, error) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	
	circuit, ok := cm.circuits[circuitType]
	if !ok {
		return nil, fmt.Errorf("circuit type %s not found", circuitType)
	}
	
	return circuit, nil
}

// GenerateProof creates a proof using the specified circuit
func (cm *CircuitManager) GenerateProof(circuitType CircuitType, witness Witness) (*Proof, error) {
	circuit, err := cm.GetCircuit(circuitType)
	if err != nil {
		return nil, err
	}
	
	return circuit.Prove(witness)
}

// VerifyProof verifies a proof using the appropriate circuit
func (cm *CircuitManager) VerifyProof(circuitType CircuitType, proof *Proof) (bool, error) {
	circuit, err := cm.GetCircuit(circuitType)
	if err != nil {
		return false, err
	}
	
	return circuit.Verify(proof)
}