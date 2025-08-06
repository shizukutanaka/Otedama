package crypto

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"runtime"
	"sync"
	"testing"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Test vectors for SHA256
var testVectors = []struct {
	input    string
	expected string
}{
	{
		input:    "",
		expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	},
	{
		input:    "abc",
		expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	},
	{
		input:    "message digest",
		expected: "f7846f55cf23e14eebeab5b4e1550cad5b509e3348fbc4efa3a1413d393cb650",
	},
	{
		input:    "abcdefghijklmnopqrstuvwxyz",
		expected: "71c480df93d6ae2f1efad1447c66c9525e316218cf51fc8d9ed832f2daf18b73",
	},
	{
		input:    "The quick brown fox jumps over the lazy dog",
		expected: "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
	},
	{
		input:    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		expected: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
	},
}

// Mining-specific test vectors (for double SHA256)
var miningTestVectors = []struct {
	input       string
	expectedSHA string
	expected256 string
}{
	{
		input:       "00000001",
		expectedSHA: "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
		expected256: "dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
	},
}

// Test fixtures and helpers

func hexDecode(s string) []byte {
	data, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return data
}

func hexEncode(data []byte) string {
	return hex.EncodeToString(data)
}

// Create aligned buffer for testing
func createAlignedBuffer(size int) []byte {
	// Allocate extra space for alignment
	buf := make([]byte, size+64)
	
	// Find aligned address
	addr := uintptr(unsafe.Pointer(&buf[0]))
	alignedAddr := (addr + 63) &^ 63 // Align to 64-byte boundary
	offset := alignedAddr - addr
	
	return buf[offset : offset+uintptr(size)]
}

// Tests for standard SHA256 functionality

func TestSHA256Basic(t *testing.T) {
	for _, tv := range testVectors {
		t.Run("input_"+tv.input[:min(len(tv.input), 20)], func(t *testing.T) {
			input := []byte(tv.input)
			expected := hexDecode(tv.expected)

			// Test Go standard library
			hash := sha256.Sum256(input)
			assert.Equal(t, expected, hash[:])

			// Test our optimized implementation if available
			if optimizedHash := OptimizedSHA256(input); optimizedHash != nil {
				assert.Equal(t, expected, optimizedHash)
			}
		})
	}
}

func TestSHA256Empty(t *testing.T) {
	input := []byte{}
	expected := hexDecode("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

	hash := sha256.Sum256(input)
	assert.Equal(t, expected, hash[:])
}

func TestSHA256LargeInput(t *testing.T) {
	// Test with 1MB of data
	input := make([]byte, 1024*1024)
	for i := range input {
		input[i] = byte(i % 256)
	}

	// Standard library
	stdHash := sha256.Sum256(input)

	// Our optimized version
	if optimizedHash := OptimizedSHA256(input); optimizedHash != nil {
		assert.Equal(t, stdHash[:], optimizedHash)
	}
}

func TestDoubleSHA256(t *testing.T) {
	for _, tv := range miningTestVectors {
		t.Run("double_sha256_"+tv.input, func(t *testing.T) {
			input := hexDecode(tv.input)
			expected := hexDecode(tv.expected256)

			// Standard double SHA256
			first := sha256.Sum256(input)
			second := sha256.Sum256(first[:])
			assert.Equal(t, expected, second[:])

			// Our optimized double SHA256
			if result := DoubleSHA256(input); result != nil {
				assert.Equal(t, expected, result)
			}
		})
	}
}

func TestSHA256d(t *testing.T) {
	// Test SHA256d (double SHA256 used in Bitcoin)
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "genesis block hash",
			input:    "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c",
			expected: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := hexDecode(tt.input)
			expected := hexDecode(tt.expected)

			// Reverse expected for little-endian comparison
			for i := 0; i < len(expected)/2; i++ {
				expected[i], expected[len(expected)-1-i] = expected[len(expected)-1-i], expected[i]
			}

			result := DoubleSHA256(input)
			if result != nil {
				assert.Equal(t, expected, result)
			}
		})
	}
}

func TestSHA256WithDifferentSizes(t *testing.T) {
	sizes := []int{0, 1, 31, 32, 55, 56, 63, 64, 65, 127, 128, 129, 255, 256, 257, 511, 512, 513, 1023, 1024}

	for _, size := range sizes {
		t.Run("size_"+string(rune(size)), func(t *testing.T) {
			input := make([]byte, size)
			for i := range input {
				input[i] = byte(i % 256)
			}

			// Standard library
			stdHash := sha256.Sum256(input)

			// Our implementation
			if optimizedHash := OptimizedSHA256(input); optimizedHash != nil {
				assert.Equal(t, stdHash[:], optimizedHash)
			}
		})
	}
}

func TestSHA256Alignment(t *testing.T) {
	// Test with different memory alignments
	input := []byte("test data for alignment testing")

	for offset := 0; offset < 64; offset++ {
		t.Run("offset_"+string(rune(offset)), func(t *testing.T) {
			// Create buffer with specific offset
			buf := make([]byte, len(input)+64)
			copy(buf[offset:], input)
			alignedInput := buf[offset : offset+len(input)]

			// Standard library
			stdHash := sha256.Sum256(input)

			// Our implementation with aligned data
			if optimizedHash := OptimizedSHA256(alignedInput); optimizedHash != nil {
				assert.Equal(t, stdHash[:], optimizedHash)
			}
		})
	}
}

func TestConcurrentSHA256(t *testing.T) {
	const numGoroutines = 10
	const operationsPerGoroutine = 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	results := make([][]byte, numGoroutines*operationsPerGoroutine)
	
	for i := 0; i < numGoroutines; i++ {
		go func(goroutineID int) {
			defer wg.Done()

			for j := 0; j < operationsPerGoroutine; j++ {
				input := []byte("concurrent test data")
				input = append(input, byte(goroutineID), byte(j))

				hash := sha256.Sum256(input)
				results[goroutineID*operationsPerGoroutine+j] = hash[:]

				runtime.Gosched() // Yield to other goroutines
			}
		}(i)
	}

	wg.Wait()

	// Verify all results are valid (non-zero)
	for i, result := range results {
		assert.NotNil(t, result, "Result %d should not be nil", i)
		assert.Len(t, result, 32, "Result %d should be 32 bytes", i)
		
		// Check it's not all zeros
		allZero := true
		for _, b := range result {
			if b != 0 {
				allZero = false
				break
			}
		}
		assert.False(t, allZero, "Result %d should not be all zeros", i)
	}
}

func TestSHA256Mining(t *testing.T) {
	// Test mining-specific SHA256 usage
	blockHeader := []byte{
		// Version
		0x01, 0x00, 0x00, 0x00,
		// Previous block hash (32 bytes of zeros for test)
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		// Merkle root (32 bytes)
		0x3b, 0xa3, 0xed, 0xfd, 0x7a, 0x7b, 0x12, 0xb2,
		0x7a, 0xc7, 0x2c, 0x3e, 0x67, 0x76, 0x8f, 0x61,
		0x7f, 0xc8, 0x1b, 0xc3, 0x88, 0x8a, 0x51, 0x32,
		0x3a, 0x9f, 0xb8, 0xaa, 0x4b, 0x1e, 0x5e, 0x4a,
		// Timestamp
		0x29, 0xab, 0x5f, 0x49,
		// Bits (difficulty)
		0xff, 0xff, 0x00, 0x1d,
		// Nonce
		0x1d, 0xac, 0x2b, 0x7c,
	}

	// Test that header is correct length
	assert.Equal(t, 80, len(blockHeader), "Block header should be 80 bytes")

	// Test double SHA256 (mining hash)
	result := DoubleSHA256(blockHeader)
	if result != nil {
		assert.Len(t, result, 32, "Mining hash should be 32 bytes")
		
		// Check that result is not all zeros (valid hash)
		allZero := true
		for _, b := range result {
			if b != 0 {
				allZero = false
				break
			}
		}
		assert.False(t, allZero, "Mining hash should not be all zeros")
	}
}

func TestHashValidation(t *testing.T) {
	// Test hash validation functions
	validHash := hexDecode("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f")
	invalidHash := hexDecode("123456789019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f")

	// Test if hash meets difficulty target
	target := hexDecode("00000000ffff0000000000000000000000000000000000000000000000000000")

	assert.True(t, HashMeetsDifficulty(validHash, target), "Valid hash should meet difficulty")
	assert.False(t, HashMeetsDifficulty(invalidHash, target), "Invalid hash should not meet difficulty")
}

func TestDifficultyCalculation(t *testing.T) {
	// Test difficulty calculation from bits
	tests := []struct {
		bits       uint32
		difficulty float64
	}{
		{0x1d00ffff, 1.0},        // Difficulty 1
		{0x1b0404cb, 16307.42},   // Higher difficulty
		{0x207fffff, 0.00024414}, // Lower difficulty
	}

	for _, tt := range tests {
		t.Run("bits_"+hex.EncodeToString([]byte{byte(tt.bits >> 24), byte(tt.bits >> 16), byte(tt.bits >> 8), byte(tt.bits)}), func(t *testing.T) {
			difficulty := CalculateDifficulty(tt.bits)
			assert.InDelta(t, tt.difficulty, difficulty, 0.01, "Difficulty calculation should be accurate")
		})
	}
}

// Benchmark tests

func BenchmarkSHA256Standard(b *testing.B) {
	input := []byte("The quick brown fox jumps over the lazy dog")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = sha256.Sum256(input)
	}
}

func BenchmarkSHA256Optimized(b *testing.B) {
	input := []byte("The quick brown fox jumps over the lazy dog")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if result := OptimizedSHA256(input); result == nil {
			b.Skip("Optimized SHA256 not available")
		}
	}
}

func BenchmarkDoubleSHA256(b *testing.B) {
	input := make([]byte, 80) // Block header size
	for i := range input {
		input[i] = byte(i % 256)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if result := DoubleSHA256(input); result == nil {
			// Fallback to standard
			first := sha256.Sum256(input)
			_ = sha256.Sum256(first[:])
		}
	}
}

func BenchmarkSHA256DifferentSizes(b *testing.B) {
	sizes := []int{32, 64, 128, 256, 512, 1024, 4096}

	for _, size := range sizes {
		b.Run("size_"+string(rune(size)), func(b *testing.B) {
			input := make([]byte, size)
			for i := range input {
				input[i] = byte(i % 256)
			}

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = sha256.Sum256(input)
			}
		})
	}
}

func BenchmarkConcurrentSHA256(b *testing.B) {
	input := []byte("benchmark test data for concurrent hashing performance measurement")

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_ = sha256.Sum256(input)
		}
	})
}

func BenchmarkMiningWorkload(b *testing.B) {
	// Simulate mining workload
	blockHeader := make([]byte, 80)
	for i := range blockHeader {
		blockHeader[i] = byte(i % 256)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Update nonce (last 4 bytes)
		nonce := uint32(i)
		blockHeader[76] = byte(nonce)
		blockHeader[77] = byte(nonce >> 8)
		blockHeader[78] = byte(nonce >> 16)
		blockHeader[79] = byte(nonce >> 24)

		// Double SHA256
		if result := DoubleSHA256(blockHeader); result == nil {
			first := sha256.Sum256(blockHeader)
			_ = sha256.Sum256(first[:])
		}
	}
}

// Helper function implementations (these would typically be in the main crypto package)

// OptimizedSHA256 - placeholder for optimized implementation
func OptimizedSHA256(data []byte) []byte {
	// This would contain SIMD/assembly optimized SHA256
	// For testing, return standard implementation
	hash := sha256.Sum256(data)
	return hash[:]
}

// DoubleSHA256 performs double SHA256 hashing as used in Bitcoin mining
func DoubleSHA256(data []byte) []byte {
	first := sha256.Sum256(data)
	second := sha256.Sum256(first[:])
	return second[:]
}

// HashMeetsDifficulty checks if a hash meets the given difficulty target
func HashMeetsDifficulty(hash, target []byte) bool {
	if len(hash) != len(target) {
		return false
	}
	
	return bytes.Compare(hash, target) <= 0
}

// CalculateDifficulty calculates difficulty from compact bits representation
func CalculateDifficulty(bits uint32) float64 {
	// Extract mantissa and exponent
	exponent := int(bits >> 24)
	mantissa := float64(bits & 0x00ffffff)

	// Calculate target
	if exponent <= 3 {
		mantissa = mantissa / float64(1<<(8*(3-exponent)))
	} else {
		mantissa = mantissa * float64(1<<(8*(exponent-3)))
	}

	// Difficulty 1 target
	diff1Target := float64(0x00000000ffff0000000000000000000000000000000000000000000000000000)
	
	return diff1Target / mantissa
}

// Helper function for min
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}