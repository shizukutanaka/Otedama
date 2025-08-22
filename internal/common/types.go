package common

import (
	"context"
	"time"
)

// Common types and interfaces used across the application

type Worker struct {
	ID            string
	Name          string
	Address       string
	LastSeen      time.Time
	Hashrate      float64
	SharesValid   uint64
	SharesInvalid uint64
	Connected     bool
}

type Share struct {
	ID         string
	WorkerID   string
	JobID      string
	Nonce      uint64
	Hash       string
	Difficulty float64
	Valid      bool
	Timestamp  time.Time
}

type Job struct {
	ID         string
	Height     uint64
	Target     string
	HeaderHash string
	SeedHash   string
	Timestamp  time.Time
}

type Pool struct {
	ID       string
	Name     string
	URL      string
	Username string
	Password string
	Priority int
	Enabled  bool
}

type Config struct {
	ListenAddr      string
	DatabaseURL     string
	LogLevel        string
	MaxWorkers      int
	ShareDifficulty float64
}

type Service interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	Health() error
}

type Logger interface {
	Debug(msg string, fields ...interface{})
	Info(msg string, fields ...interface{})
	Warn(msg string, fields ...interface{})
	Error(msg string, fields ...interface{})
}

type Metrics struct {
	TotalShares   uint64
	ValidShares   uint64
	InvalidShares uint64
	Hashrate      float64
	ActiveWorkers int
	Uptime        time.Duration
}