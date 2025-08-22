package algorithms

import (
	"bytes"
	"testing"
)

func TestRandomX_Hash(t *testing.T) {
	// Initialize the RandomX algorithm
	r := NewRandomX()

	// Test case 1: Basic hash generation
	input1 := []byte("hello world")
	hash1 := r.Hash(input1)

	if len(hash1) != 32 {
		t.Errorf("RandomX hash length is incorrect, got %d, want 32", len(hash1))
	}

	// Test case 2: Consistency check
	hash2 := r.Hash(input1)
	if !bytes.Equal(hash1, hash2) {
		t.Error("RandomX hash is not consistent for the same input")
	}

	// Test case 3: Different input should produce different hash
	input2 := []byte("hello cascade")
	hash3 := r.Hash(input2)
	if bytes.Equal(hash1, hash3) {
		t.Error("RandomX hash for different inputs should not be the same")
	}

	// Test case 4: Known value check (if available)
	// This requires a known input and its corresponding RandomX hash.
	// For now, we are ensuring the basic functionality.
	// Example known test vector (replace with actual if found):
	/*
		knownInput := []byte("test vector")
		knownHashHex := "..."
		knownHash, _ := hex.DecodeString(knownHashHex)

		testHash := r.Hash(knownInput)
		if !bytes.Equal(testHash, knownHash) {
			t.Errorf("Hash does not match known test vector. Got %x, want %x", testHash, knownHash)
		}
	*/
}
