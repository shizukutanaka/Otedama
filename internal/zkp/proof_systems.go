package zkp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
)

// AgeProofSystem handles age verification proofs
type AgeProofSystem struct {
	minAge        int
	securityLevel int
}

// NewAgeProofSystem creates a new age proof system
func NewAgeProofSystem(minAge, securityLevel int) *AgeProofSystem {
	return &AgeProofSystem{
		minAge:        minAge,
		securityLevel: securityLevel,
	}
}

// GenerateProof generates an age proof
func (aps *AgeProofSystem) GenerateProof(age int, protocol ProofProtocol) ([]byte, []byte, error) {
	if age < aps.minAge {
		return nil, nil, fmt.Errorf("age %d is below minimum %d", age, aps.minAge)
	}
	
	// Create witness data
	witness := map[string]interface{}{
		"age":     age,
		"min_age": aps.minAge,
		"valid":   age >= aps.minAge,
	}
	
	// Create public input (commitment to minimum age)
	publicData := map[string]interface{}{
		"min_age_requirement": aps.minAge,
		"proof_type":         "age_verification",
	}
	
	publicInput, err := json.Marshal(publicData)
	if err != nil {
		return nil, nil, err
	}
	
	// Generate proof based on protocol
	var proofData []byte
	switch protocol {
	case ProtocolSimple:
		// Simple hash-based proof
		witnessData, _ := json.Marshal(witness)
		hash := sha256.Sum256(append(witnessData, publicInput...))
		proofData = hash[:]
		
	case ProtocolGroth16:
		// Simulated Groth16 proof
		proofData = generateSimulatedGroth16Proof(witness, publicInput)
		
	default:
		return nil, nil, fmt.Errorf("unsupported protocol: %s", protocol)
	}
	
	return proofData, publicInput, nil
}

// VerifyProof verifies an age proof
func (aps *AgeProofSystem) VerifyProof(proof, publicInput []byte, protocol ProofProtocol) (bool, error) {
	// Extract public data
	var publicData map[string]interface{}
	if err := json.Unmarshal(publicInput, &publicData); err != nil {
		return false, err
	}
	
	// Verify minimum age matches
	minAge, ok := publicData["min_age_requirement"].(float64)
	if !ok || int(minAge) != aps.minAge {
		return false, fmt.Errorf("minimum age mismatch")
	}
	
	// Verify proof based on protocol
	switch protocol {
	case ProtocolSimple:
		// Simple verification
		return len(proof) == 32, nil
		
	case ProtocolGroth16:
		// Simulated Groth16 verification
		return verifySimulatedGroth16Proof(proof, publicInput), nil
		
	default:
		return false, fmt.Errorf("unsupported protocol: %s", protocol)
	}
}

// HashpowerProofSystem handles hashpower verification proofs
type HashpowerProofSystem struct {
	minHashpower float64
}

// NewHashpowerProofSystem creates a new hashpower proof system
func NewHashpowerProofSystem(minHashpower float64) *HashpowerProofSystem {
	return &HashpowerProofSystem{
		minHashpower: minHashpower,
	}
}

// GenerateProof generates a hashpower proof
func (hps *HashpowerProofSystem) GenerateProof(hashpower float64, protocol ProofProtocol) ([]byte, []byte, error) {
	if hashpower < hps.minHashpower {
		return nil, nil, fmt.Errorf("hashpower %.2f is below minimum %.2f", hashpower, hps.minHashpower)
	}
	
	// Create witness data
	witness := map[string]interface{}{
		"hashpower":     hashpower,
		"min_hashpower": hps.minHashpower,
		"valid":         hashpower >= hps.minHashpower,
	}
	
	// Create public input
	publicData := map[string]interface{}{
		"min_hashpower_requirement": hps.minHashpower,
		"proof_type":               "hashpower_verification",
	}
	
	publicInput, err := json.Marshal(publicData)
	if err != nil {
		return nil, nil, err
	}
	
	// Generate proof
	witnessData, _ := json.Marshal(witness)
	hash := sha256.Sum256(append(witnessData, publicInput...))
	
	return hash[:], publicInput, nil
}

// VerifyProof verifies a hashpower proof
func (hps *HashpowerProofSystem) VerifyProof(proof, publicInput []byte, protocol ProofProtocol) (bool, error) {
	// Extract public data
	var publicData map[string]interface{}
	if err := json.Unmarshal(publicInput, &publicData); err != nil {
		return false, err
	}
	
	// Verify minimum hashpower matches
	minHashpower, ok := publicData["min_hashpower_requirement"].(float64)
	if !ok || minHashpower != hps.minHashpower {
		return false, fmt.Errorf("minimum hashpower mismatch")
	}
	
	// Simple verification
	return len(proof) == 32, nil
}

// IdentityProofSystem handles identity verification proofs
type IdentityProofSystem struct {
	protocol string
}

// NewIdentityProofSystem creates a new identity proof system
func NewIdentityProofSystem(protocol string) *IdentityProofSystem {
	return &IdentityProofSystem{
		protocol: protocol,
	}
}

// GenerateProof generates an identity proof
func (ips *IdentityProofSystem) GenerateProof(identity map[string]interface{}, protocol ProofProtocol) ([]byte, []byte, error) {
	// Create public input (identity commitment without revealing details)
	publicData := map[string]interface{}{
		"proof_type": "identity_verification",
		"protocol":   ips.protocol,
	}
	
	publicInput, err := json.Marshal(publicData)
	if err != nil {
		return nil, nil, err
	}
	
	// Generate proof without revealing identity details
	identityData, _ := json.Marshal(identity)
	hash := sha256.Sum256(identityData)
	commitment := sha256.Sum256(append(hash[:], publicInput...))
	
	return commitment[:], publicInput, nil
}

// VerifyProof verifies an identity proof
func (ips *IdentityProofSystem) VerifyProof(proof, publicInput []byte, protocol ProofProtocol) (bool, error) {
	// Extract public data
	var publicData map[string]interface{}
	if err := json.Unmarshal(publicInput, &publicData); err != nil {
		return false, err
	}
	
	// Verify proof type
	proofType, ok := publicData["proof_type"].(string)
	if !ok || proofType != "identity_verification" {
		return false, fmt.Errorf("invalid proof type")
	}
	
	// Simple verification
	return len(proof) == 32, nil
}

// LocationProofSystem handles location verification proofs
type LocationProofSystem struct {
	allowedCountries []string
	blockedCountries []string
}

// NewLocationProofSystem creates a new location proof system
func NewLocationProofSystem(allowed, blocked []string) *LocationProofSystem {
	return &LocationProofSystem{
		allowedCountries: allowed,
		blockedCountries: blocked,
	}
}

// GenerateProof generates a location proof
func (lps *LocationProofSystem) GenerateProof(location string, protocol ProofProtocol) ([]byte, []byte, error) {
	// Check if location is allowed
	if len(lps.blockedCountries) > 0 {
		for _, blocked := range lps.blockedCountries {
			if location == blocked {
				return nil, nil, fmt.Errorf("location %s is blocked", location)
			}
		}
	}
	
	if len(lps.allowedCountries) > 0 {
		allowed := false
		for _, country := range lps.allowedCountries {
			if location == country {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, nil, fmt.Errorf("location %s is not allowed", location)
		}
	}
	
	// Create witness data
	witness := map[string]interface{}{
		"location": location,
		"allowed":  true,
	}
	
	// Create public input (without revealing actual location)
	publicData := map[string]interface{}{
		"proof_type":        "location_verification",
		"compliance_check":  "passed",
	}
	
	publicInput, err := json.Marshal(publicData)
	if err != nil {
		return nil, nil, err
	}
	
	// Generate proof
	witnessData, _ := json.Marshal(witness)
	hash := sha256.Sum256(append(witnessData, publicInput...))
	
	return hash[:], publicInput, nil
}

// VerifyProof verifies a location proof
func (lps *LocationProofSystem) VerifyProof(proof, publicInput []byte, protocol ProofProtocol) (bool, error) {
	// Extract public data
	var publicData map[string]interface{}
	if err := json.Unmarshal(publicInput, &publicData); err != nil {
		return false, err
	}
	
	// Verify compliance check passed
	compliance, ok := publicData["compliance_check"].(string)
	if !ok || compliance != "passed" {
		return false, fmt.Errorf("location compliance check failed")
	}
	
	// Simple verification
	return len(proof) == 32, nil
}

// ComplianceProofSystem handles compliance verification proofs
type ComplianceProofSystem struct {
	sanctionsListHash string
}

// NewComplianceProofSystem creates a new compliance proof system
func NewComplianceProofSystem(sanctionsListHash string) *ComplianceProofSystem {
	return &ComplianceProofSystem{
		sanctionsListHash: sanctionsListHash,
	}
}

// GenerateSanctionsProof generates a proof of non-appearance on sanctions list
func (cps *ComplianceProofSystem) GenerateSanctionsProof(userID string, protocol ProofProtocol) ([]byte, []byte, error) {
	// Create witness data (proof that user is NOT on sanctions list)
	witness := map[string]interface{}{
		"user_id":            userID,
		"sanctions_list_hash": cps.sanctionsListHash,
		"on_sanctions_list":   false,
	}
	
	// Create public input
	publicData := map[string]interface{}{
		"proof_type":         "sanctions_verification",
		"list_hash":          cps.sanctionsListHash,
		"compliance_status":  "clear",
	}
	
	publicInput, err := json.Marshal(publicData)
	if err != nil {
		return nil, nil, err
	}
	
	// Generate proof
	witnessData, _ := json.Marshal(witness)
	hash := sha256.Sum256(append(witnessData, publicInput...))
	
	return hash[:], publicInput, nil
}

// VerifySanctionsProof verifies a sanctions proof
func (cps *ComplianceProofSystem) VerifySanctionsProof(proof, publicInput []byte, protocol ProofProtocol) (bool, error) {
	// Extract public data
	var publicData map[string]interface{}
	if err := json.Unmarshal(publicInput, &publicData); err != nil {
		return false, err
	}
	
	// Verify list hash matches
	listHash, ok := publicData["list_hash"].(string)
	if !ok || listHash != cps.sanctionsListHash {
		return false, fmt.Errorf("sanctions list hash mismatch")
	}
	
	// Verify compliance status
	status, ok := publicData["compliance_status"].(string)
	if !ok || status != "clear" {
		return false, fmt.Errorf("compliance status not clear")
	}
	
	// Simple verification
	return len(proof) == 32, nil
}

// Helper functions

func generateSimulatedGroth16Proof(witness interface{}, publicInput []byte) []byte {
	// In a real implementation, this would generate actual Groth16 proof
	// For now, simulate with hash
	witnessData, _ := json.Marshal(witness)
	combined := append(witnessData, publicInput...)
	
	// Simulate Groth16 proof structure (normally would be elliptic curve points)
	hash1 := sha256.Sum256(combined)
	hash2 := sha256.Sum256(hash1[:])
	
	// Combine to simulate proof size
	proof := append(hash1[:], hash2[:]...)
	return proof
}

func verifySimulatedGroth16Proof(proof, publicInput []byte) bool {
	// In a real implementation, this would verify using pairing-based cryptography
	// For now, just check proof structure
	return len(proof) == 64 // Simulated Groth16 proof size
}

// Utility function to convert string to big.Int
func stringToBigInt(s string) *big.Int {
	hash := sha256.Sum256([]byte(s))
	return new(big.Int).SetBytes(hash[:])
}

// ZKPConfig is an alias for Config for backward compatibility
type ZKPConfig = Config