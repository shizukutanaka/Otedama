# Mining Engine Tests

This directory contains comprehensive unit and integration tests for the Otedama mining engine.

## Test Files

### `engine_test.go`
Main unit tests for the mining engine covering:
- Engine initialization with various configurations
- Start/stop functionality
- Job submission and distribution
- Hash rate calculation
- Worker management
- Thread safety and concurrent operations
- Edge cases and error handling
- Performance benchmarks

### `engine_integration_test.go`
Integration tests that require real hardware or longer execution times:
- Integration with OptimizedMiningEngine
- Real hardware detection
- Performance testing
- Memory usage under load
- Concurrent job submission stress testing

### `test_helpers.go`
Test utilities and mocks:
- MockEngine for testing dependent components
- MockHardwareDetector for simulating hardware
- TestJobGenerator for creating test jobs
- Helper functions for assertions and waiting

## Running Tests

### Run all unit tests:
```bash
go test -v ./internal/mining/
```

### Run with coverage:
```bash
go test -v -cover ./internal/mining/
```

### Run integration tests (slower):
```bash
go test -v -tags=integration ./internal/mining/
```

### Run specific test:
```bash
go test -v -run TestNewEngine ./internal/mining/
```

### Run benchmarks:
```bash
go test -bench=. ./internal/mining/
```

### Run with race detection:
```bash
go test -race -v ./internal/mining/
```

## Test Coverage Areas

1. **Initialization Testing**
   - Various thread configurations
   - CPU affinity settings
   - Worker initialization
   - Configuration validation

2. **Start/Stop Testing**
   - Normal operation flow
   - Multiple start attempts
   - Context cancellation
   - Graceful shutdown

3. **Job Processing**
   - Job distribution across workers
   - Nonce range calculations
   - Edge cases (zero range, max uint64)
   - Job submission to stopped engine

4. **Error Handling**
   - Invalid configurations
   - Resource exhaustion
   - Concurrent operation safety
   - Recovery from errors

5. **Performance Testing**
   - Hash rate calculation accuracy
   - Mining performance benchmarks
   - Memory usage under load
   - Concurrent job submission

## Key Test Scenarios

### Basic Usage
```go
// Create engine
engine, err := NewEngine(config, logger)

// Start mining
err = engine.Start(ctx)

// Submit job
engine.SubmitJob(job)

// Check hash rate
rate := engine.GetHashRate()

// Stop mining
err = engine.Stop()
```

### Edge Cases Tested
- Zero thread count (defaults to NumCPU)
- Negative thread count (corrected to NumCPU)
- Empty nonce range
- Maximum nonce values
- Rapid start/stop cycles
- High concurrent load

## Mocking

The test suite includes comprehensive mocks for:
- Engine interface
- Hardware detector
- Job generation
- Logger with capture capabilities

## Performance Benchmarks

Benchmarks measure:
- Hash computation speed
- Job submission throughput
- Memory allocation patterns
- Concurrent operation overhead

## Notes

- Integration tests may take longer and are tagged with `+build integration`
- Some tests require actual hardware detection and may skip on CI environments
- Performance tests have minimum thresholds but actual results depend on hardware
- Race detection is recommended for concurrent operation tests