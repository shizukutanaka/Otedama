package zkp

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"testing"
	"time"

	"go.uber.org/zap"
)

// Benchmarks for ZKP implementations
// Following John Carmack's approach: measure everything, optimize the bottlenecks

func BenchmarkGroth16(b *testing.B) {
	logger, _ := zap.NewDevelopment()
	groth16 := NewOptimizedGroth16(logger)
	
	// Setup circuit
	circuit := &Circuit{
		Constraints: generateTestConstraints(100),
		Wires:       100,
		PublicInputs: 10,
	}
	
	err := groth16.Setup(circuit)
	if err != nil {
		b.Fatal(err)
	}
	
	// Generate test data
	witness := make([]byte, 100*32)
	rand.Read(witness)
	publicInputs := make([]byte, 10*32)
	rand.Read(publicInputs)
	
	b.Run("Prove", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, err := groth16.Prove(witness, publicInputs)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	
	// Generate proof for verification
	proof, _ := groth16.Prove(witness, publicInputs)
	
	b.Run("Verify", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			valid, err := groth16.Verify(proof, publicInputs)
			if err != nil || !valid {
				b.Fatal("verification failed")
			}
		}
	})
}

func BenchmarkPLONK(b *testing.B) {
	logger, _ := zap.NewDevelopment()
	plonk := NewOptimizedPLONK(logger)
	
	// Setup circuit
	circuit := &Circuit{
		Constraints: generateTestConstraints(100),
		Wires:       100,
		PublicInputs: 10,
	}
	
	err := plonk.Setup(circuit, 4096)
	if err != nil {
		b.Fatal(err)
	}
	
	witness := make([]byte, 100*32)
	rand.Read(witness)
	publicInputs := make([]byte, 10*32)
	rand.Read(publicInputs)
	
	b.Run("Prove", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, err := plonk.Prove(witness, publicInputs)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	
	proof, _ := plonk.Prove(witness, publicInputs)
	
	b.Run("Verify", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			valid, err := plonk.Verify(proof, publicInputs)
			if err != nil || !valid {
				b.Fatal("verification failed")
			}
		}
	})
}

func BenchmarkSTARK(b *testing.B) {
	logger, _ := zap.NewDevelopment()
	stark := NewOptimizedSTARK(logger)
	
	// Generate test trace
	traceLength := 256
	trace := make([][]byte, traceLength)
	for i := range trace {
		trace[i] = make([]byte, 32)
		rand.Read(trace[i])
	}
	
	publicInputs := make([]byte, 32)
	rand.Read(publicInputs)
	
	b.Run("Prove", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, err := stark.Prove(trace, publicInputs)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	
	proof, _ := stark.Prove(trace, publicInputs)
	
	b.Run("Verify", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			valid, err := stark.Verify(proof, publicInputs)
			if err != nil || !valid {
				b.Fatal("verification failed")
			}
		}
	})
}

func BenchmarkAgeProof(b *testing.B) {
	logger, _ := zap.NewDevelopment()
	ageSystem, err := NewAgeProofSystem(logger, 18)
	if err != nil {
		b.Fatal(err)
	}
	
	// Test birth date (25 years old)
	birthDate := time.Now().AddDate(-25, 0, 0)
	userID := "test_user"
	
	b.Run("GenerateProof", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, err := ageSystem.GenerateAgeProof(userID, birthDate, "groth16")
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	
	proof, _ := ageSystem.GenerateAgeProof(userID, birthDate, "groth16")
	
	b.Run("VerifyProof", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			valid, err := ageSystem.VerifyAgeProof(proof)
			if err != nil || !valid {
				b.Fatal("verification failed")
			}
		}
	})
}

func BenchmarkHashpowerProof(b *testing.B) {
	logger, _ := zap.NewDevelopment()
	hashpowerSystem := NewHashpowerProofSystem(logger, 1000000) // 1 MH/s
	
	userID := "test_miner"
	
	b.Run("SolveChallenge", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			challenge, _ := hashpowerSystem.GenerateHashpowerChallenge(userID, "sha256")
			// Make challenge easier for benchmark
			challenge.Difficulty = new(big.Int).SetBytes([]byte{255, 255, 255, 255})
			
			_, err := hashpowerSystem.SolveChallenge(challenge)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkEllipticCurveOperations(b *testing.B) {
	curve := NewBN254Curve()
	
	// Generate random scalars
	scalar1 := generateRandomField()
	scalar2 := generateRandomField()
	
	// Get generator
	g := curve.Generator()
	
	b.Run("ScalarMult", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = curve.ScalarMult(g, scalar1.value)
		}
	})
	
	// Generate two random points
	p1 := curve.ScalarMult(g, scalar1.value)
	p2 := curve.ScalarMult(g, scalar2.value)
	
	b.Run("PointAdd", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = curve.Add(p1, p2)
		}
	})
	
	b.Run("PointDouble", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = curve.Double(p1)
		}
	})
}

func BenchmarkFFT(b *testing.B) {
	sizes := []int{256, 512, 1024, 2048, 4096}
	field := getPrimeField()
	
	for _, size := range sizes {
		b.Run(fmt.Sprintf("Size%d", size), func(b *testing.B) {
			fft := NewFFT(size, field)
			
			// Generate random coefficients
			coeffs := make([]*MontgomeryField, size)
			for i := range coeffs {
				coeffs[i] = NewMontgomeryField(generateRandomBigInt(), field)
			}
			
			b.Run("Forward", func(b *testing.B) {
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					_ = fft.Forward(coeffs)
				}
			})
			
			values := fft.Forward(coeffs)
			
			b.Run("Inverse", func(b *testing.B) {
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					_ = fft.Inverse(values)
				}
			})
		})
	}
}

func BenchmarkMontgomeryArithmetic(b *testing.B) {
	field := getPrimeField()
	a := NewMontgomeryField(generateRandomBigInt(), field)
	b := NewMontgomeryField(generateRandomBigInt(), field)
	
	b.Run("Multiply", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = a.Multiply(b)
		}
	})
	
	// Compare with regular big.Int multiplication
	b.Run("BigIntMultiply", func(b *testing.B) {
		x := generateRandomBigInt()
		y := generateRandomBigInt()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			result := new(big.Int).Mul(x, y)
			result.Mod(result, field)
		}
	})
}

func BenchmarkBatchVerification(b *testing.B) {
	logger, _ := zap.NewDevelopment()
	manager := &EnhancedZKPManager{
		logger:    logger,
		config:    ZKPConfig{BatchVerification: true},
		verifiers: make(map[ProofProtocol]Verifier),
	}
	
	// Setup Groth16 verifier
	manager.verifiers[ProtocolGroth16] = NewGroth16Verifier(logger)
	
	// Generate test proofs
	numProofs := 100
	proofs := make([]*EnhancedProof, numProofs)
	proofIDs := make([]string, numProofs)
	
	for i := 0; i < numProofs; i++ {
		proof := &EnhancedProof{
			ID:       fmt.Sprintf("proof_%d", i),
			Protocol: ProtocolGroth16,
			Valid:    true,
			ExpiresAt: time.Now().Add(time.Hour),
		}
		proofs[i] = proof
		proofIDs[i] = proof.ID
		manager.proofs.Store(proof.ID, proof)
	}
	
	b.Run("BatchVerify", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_, err := manager.BatchVerifyProofs(proofIDs)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	
	// Compare with individual verification
	b.Run("IndividualVerify", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			for _, id := range proofIDs {
				_, err := manager.VerifyProof(id)
				if err != nil {
					b.Fatal(err)
				}
			}
		}
	})
}

// Memory benchmarks
func BenchmarkMemoryUsage(b *testing.B) {
	b.Run("ProofGeneration", func(b *testing.B) {
		logger, _ := zap.NewDevelopment()
		groth16 := NewOptimizedGroth16(logger)
		
		circuit := &Circuit{
			Constraints: generateTestConstraints(1000),
			Wires:       1000,
			PublicInputs: 100,
		}
		
		groth16.Setup(circuit)
		
		witness := make([]byte, 1000*32)
		rand.Read(witness)
		publicInputs := make([]byte, 100*32)
		rand.Read(publicInputs)
		
		b.ReportAllocs()
		b.ResetTimer()
		
		for i := 0; i < b.N; i++ {
			_, _ = groth16.Prove(witness, publicInputs)
		}
	})
}

// Helper functions for benchmarks

func generateTestConstraints(n int) []Constraint {
	constraints := make([]Constraint, n)
	for i := range constraints {
		constraints[i] = Constraint{
			A: []int32{int32(i), int32(i + 1)},
			B: []int32{int32(i + 2)},
			C: []int32{int32(i + 3), int32(i + 4)},
		}
	}
	return constraints
}

func generateRandomBigInt() *big.Int {
	n, _ := rand.Int(rand.Reader, getPrimeField())
	return n
}

// Performance comparison tests

func TestPerformanceComparison(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	
	// Compare proof generation times
	results := make(map[string]time.Duration)
	
	// Groth16
	groth16 := NewOptimizedGroth16(logger)
	circuit := &Circuit{
		Constraints: generateTestConstraints(100),
		Wires:       100,
		PublicInputs: 10,
	}
	groth16.Setup(circuit)
	
	witness := make([]byte, 100*32)
	rand.Read(witness)
	publicInputs := make([]byte, 10*32)
	rand.Read(publicInputs)
	
	start := time.Now()
	_, err := groth16.Prove(witness, publicInputs)
	if err != nil {
		t.Fatal(err)
	}
	results["Groth16"] = time.Since(start)
	
	// PLONK
	plonk := NewOptimizedPLONK(logger)
	plonk.Setup(circuit, 4096)
	
	start = time.Now()
	_, err = plonk.Prove(witness, publicInputs)
	if err != nil {
		t.Fatal(err)
	}
	results["PLONK"] = time.Since(start)
	
	// Print results
	t.Logf("Proof Generation Times:")
	for name, duration := range results {
		t.Logf("%s: %v", name, duration)
	}
}

// Stress tests

func TestHighLoadProofGeneration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping stress test in short mode")
	}
	
	logger, _ := zap.NewDevelopment()
	manager := NewEnhancedZKPManager(logger, ZKPConfig{
		EnableModernProtocols: true,
		DefaultProtocol:      ProtocolGroth16,
		SecurityLevel:        256,
		ParallelProofGen:     true,
	})
	
	// Generate 1000 age proofs concurrently
	numProofs := 1000
	done := make(chan bool, numProofs)
	
	start := time.Now()
	
	for i := 0; i < numProofs; i++ {
		go func(id int) {
			userID := fmt.Sprintf("user_%d", id)
			proof, err := manager.GenerateAgeProof(userID, 25)
			if err != nil {
				t.Errorf("Failed to generate proof %d: %v", id, err)
			}
			
			// Verify immediately
			valid, err := manager.VerifyProof(proof.ID)
			if err != nil || !valid {
				t.Errorf("Failed to verify proof %d", id)
			}
			
			done <- true
		}(i)
	}
	
	// Wait for all proofs
	for i := 0; i < numProofs; i++ {
		<-done
	}
	
	elapsed := time.Since(start)
	proofsPerSecond := float64(numProofs) / elapsed.Seconds()
	
	t.Logf("Generated and verified %d proofs in %v", numProofs, elapsed)
	t.Logf("Rate: %.2f proofs/second", proofsPerSecond)
	
	// Check memory usage
	stats := manager.GetStats()
	t.Logf("Final stats: %+v", stats)
}

// Optimization validation tests

func TestOptimizationCorrectness(t *testing.T) {
	// Verify that optimized implementations produce same results
	logger, _ := zap.NewDevelopment()
	
	// Test Montgomery multiplication
	field := getPrimeField()
	a := big.NewInt(12345)
	b := big.NewInt(67890)
	
	// Regular multiplication
	regular := new(big.Int).Mul(a, b)
	regular.Mod(regular, field)
	
	// Montgomery multiplication
	aMont := NewMontgomeryField(a, field)
	bMont := NewMontgomeryField(b, field)
	montResult := aMont.Multiply(bMont)
	result := fromMontgomery(montResult.value, montResult.rInv, field)
	
	if regular.Cmp(result) != 0 {
		t.Errorf("Montgomery multiplication mismatch: got %v, want %v", result, regular)
	}
}
