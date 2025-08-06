# Otedama Coding Standards

**Version**: 2.1.5  
**Last Updated**: 2025-08-05  

## Overview

This document outlines the coding standards and best practices for maintaining high readability and maintainability in the Otedama codebase. These standards follow principles from Go's official style guide, Google's Go Style Guide, and industry best practices.

## Table of Contents

1. [Code Organization](#code-organization)
2. [Naming Conventions](#naming-conventions)
3. [Function Design](#function-design)
4. [Error Handling](#error-handling)
5. [Documentation](#documentation)
6. [Testing](#testing)
7. [Performance](#performance)
8. [Security](#security)

## Code Organization

### Package Structure
- One package per directory
- Package names should be short, concise, and lowercase
- Avoid redundant naming (e.g., `mining/mining.go` → `mining/engine.go`)

### File Organization
```
package declaration
imports (
    standard library
    external packages
    internal packages
)
constants
types
interfaces
functions
methods
```

### Import Grouping
```go
import (
    // Standard library
    "context"
    "fmt"
    "time"
    
    // External packages
    "go.uber.org/zap"
    
    // Internal packages
    "github.com/shizukutanaka/Otedama/internal/config"
    "github.com/shizukutanaka/Otedama/internal/mining"
)
```

## Naming Conventions

### General Rules
- Use descriptive names that clearly indicate purpose
- Avoid abbreviations unless widely understood
- Keep names concise but not cryptic

### Specific Conventions

#### Variables
```go
// Good
var minerCount int
var isValidShare bool
var hashRate float64

// Bad
var mc int      // unclear abbreviation
var flag bool   // too generic
var hr float64  // unclear abbreviation
```

#### Functions
```go
// Good
func CalculateHashRate(shares int, duration time.Duration) float64
func ValidateBlockHeader(header *BlockHeader) error
func StartMiningWorker(ctx context.Context, id string) error

// Bad
func CalcHR(s int, d time.Duration) float64  // abbreviations
func Check(h *BlockHeader) error             // too generic
func Worker(ctx context.Context) error       // unclear purpose
```

#### Interfaces
```go
// Good - er suffix for single method interfaces
type Miner interface {
    Mine(ctx context.Context, job *Job) (*Share, error)
}

// Good - descriptive name for multi-method interfaces
type PoolManager interface {
    AddMiner(miner Miner) error
    RemoveMiner(id string) error
    DistributeRewards() error
}
```

#### Constants
```go
// Good - all caps with underscores
const (
    MAX_WORKERS = 256
    DEFAULT_DIFFICULTY = 1000000
    SHARE_TIMEOUT = 30 * time.Second
)

// For exported constants, use CamelCase
const (
    DefaultPort = 3333
    MaxConnections = 10000
)
```

## Function Design

### Single Responsibility
Each function should do one thing well:

```go
// Good - single responsibility
func ValidateShare(share *Share) error {
    if share == nil {
        return ErrNilShare
    }
    if share.Nonce == 0 {
        return ErrInvalidNonce
    }
    if share.Difficulty < MinDifficulty {
        return ErrDifficultyTooLow
    }
    return nil
}

func ProcessShare(share *Share) error {
    if err := ValidateShare(share); err != nil {
        return fmt.Errorf("validation failed: %w", err)
    }
    if err := StoreShare(share); err != nil {
        return fmt.Errorf("storage failed: %w", err)
    }
    return nil
}
```

### Function Length
- Keep functions under 50 lines
- If longer, consider breaking into smaller functions
- Complex logic should be decomposed

### Parameters
- Limit to 5 parameters maximum
- Use structs for related parameters
- Consider functional options pattern for optional parameters

```go
// Good - options pattern
type MinerOption func(*MinerConfig)

func WithThreads(threads int) MinerOption {
    return func(c *MinerConfig) {
        c.Threads = threads
    }
}

func NewMiner(opts ...MinerOption) *Miner {
    config := DefaultMinerConfig()
    for _, opt := range opts {
        opt(config)
    }
    return &Miner{config: config}
}
```

## Error Handling

### Error Types
```go
// Define sentinel errors for common cases
var (
    ErrInvalidShare = errors.New("invalid share")
    ErrPoolFull     = errors.New("pool is full")
    ErrMinerExists  = errors.New("miner already exists")
)

// Custom error types for complex errors
type ValidationError struct {
    Field string
    Value interface{}
    Err   error
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("validation failed for %s: %v", e.Field, e.Err)
}
```

### Error Wrapping
```go
// Always wrap errors with context
if err := db.Save(share); err != nil {
    return fmt.Errorf("failed to save share %s: %w", share.ID, err)
}
```

### Error Checking
```go
// Check errors immediately
result, err := CalculateHash(data)
if err != nil {
    return nil, fmt.Errorf("hash calculation failed: %w", err)
}
```

## Documentation

### Package Documentation
```go
// Package mining implements the core mining engine for Otedama.
// It provides high-performance mining capabilities with support
// for multiple algorithms and hardware types.
package mining
```

### Function Documentation
```go
// CalculateHashRate computes the mining hash rate based on the number
// of shares submitted over a given time period.
//
// Parameters:
//   - shares: number of valid shares submitted
//   - duration: time period over which shares were submitted
//
// Returns the hash rate in hashes per second.
func CalculateHashRate(shares int, duration time.Duration) float64 {
    if duration == 0 {
        return 0
    }
    return float64(shares) * DifficultyOne / duration.Seconds()
}
```

### Interface Documentation
```go
// Miner represents a mining worker capable of solving proof-of-work puzzles.
// Implementations must be safe for concurrent use.
type Miner interface {
    // Mine attempts to find a valid nonce for the given job.
    // It returns a share if successful or an error if mining fails.
    // The context can be used to cancel mining operations.
    Mine(ctx context.Context, job *Job) (*Share, error)
    
    // GetHashRate returns the current hash rate in H/s.
    GetHashRate() float64
}
```

## Testing

### Test Naming
```go
// Test function names should clearly describe what is being tested
func TestValidateShare_NilShare_ReturnsError(t *testing.T) { }
func TestMiner_Mine_ValidJob_ReturnsShare(t *testing.T) { }
func TestPoolManager_AddMiner_DuplicateID_ReturnsError(t *testing.T) { }
```

### Table-Driven Tests
```go
func TestValidateShare(t *testing.T) {
    tests := []struct {
        name    string
        share   *Share
        wantErr error
    }{
        {
            name:    "nil share",
            share:   nil,
            wantErr: ErrNilShare,
        },
        {
            name: "invalid nonce",
            share: &Share{
                Nonce: 0,
                Difficulty: 1000000,
            },
            wantErr: ErrInvalidNonce,
        },
        {
            name: "valid share",
            share: &Share{
                Nonce: 12345,
                Difficulty: 1000000,
            },
            wantErr: nil,
        },
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            err := ValidateShare(tt.share)
            if err != tt.wantErr {
                t.Errorf("ValidateShare() error = %v, wantErr %v", err, tt.wantErr)
            }
        })
    }
}
```

## Performance

### Optimization Guidelines
1. Measure before optimizing
2. Focus on algorithmic improvements first
3. Use benchmarks to validate improvements

### Memory Management
```go
// Use sync.Pool for frequently allocated objects
var sharePool = sync.Pool{
    New: func() interface{} {
        return &Share{}
    },
}

func GetShare() *Share {
    return sharePool.Get().(*Share)
}

func PutShare(s *Share) {
    s.Reset()
    sharePool.Put(s)
}
```

### Concurrency
```go
// Use channels for communication
type Worker struct {
    jobs    <-chan Job
    results chan<- Result
}

// Protect shared state with appropriate synchronization
type SafeCounter struct {
    mu    sync.RWMutex
    value int64
}

func (c *SafeCounter) Increment() {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

func (c *SafeCounter) Value() int64 {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.value
}
```

## Security

### Input Validation
```go
// Always validate external input
func ParseMinerID(input string) (string, error) {
    // Remove any potentially dangerous characters
    cleaned := strings.TrimSpace(input)
    
    // Validate length
    if len(cleaned) == 0 || len(cleaned) > MaxMinerIDLength {
        return "", ErrInvalidMinerID
    }
    
    // Validate format
    if !minerIDRegex.MatchString(cleaned) {
        return "", ErrInvalidMinerID
    }
    
    return cleaned, nil
}
```

### Resource Limits
```go
// Always set timeouts and limits
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

// Limit concurrent operations
sem := make(chan struct{}, MaxConcurrentWorkers)
for _, job := range jobs {
    sem <- struct{}{}
    go func(j Job) {
        defer func() { <-sem }()
        process(j)
    }(job)
}
```

## Code Review Checklist

Before submitting code:
- [ ] Functions are focused and under 50 lines
- [ ] Variable and function names are descriptive
- [ ] All exported types and functions have documentation
- [ ] Errors are properly wrapped with context
- [ ] Tests cover happy path and error cases
- [ ] No unused imports or variables
- [ ] Code passes all linters (golint, go vet, golangci-lint)
- [ ] Security considerations addressed
- [ ] Performance implications considered