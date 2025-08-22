// Package utils provides utility functions for Otedama
package utils

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// AtomicFloat64 provides atomic operations for float64
type AtomicFloat64 struct {
	value uint64
}

// Load atomically loads the float64 value
func (a *AtomicFloat64) Load() float64 {
	return math.Float64frombits(atomic.LoadUint64(&a.value))
}

// Store atomically stores the float64 value
func (a *AtomicFloat64) Store(val float64) {
	atomic.StoreUint64(&a.value, math.Float64bits(val))
}

// Add atomically adds to the float64 value
func (a *AtomicFloat64) Add(delta float64) float64 {
	for {
		old := a.Load()
		new := old + delta
		if a.CompareAndSwap(old, new) {
			return new
		}
	}
}

// CompareAndSwap atomically compares and swaps the float64 value
func (a *AtomicFloat64) CompareAndSwap(old, new float64) bool {
	return atomic.CompareAndSwapUint64(&a.value, math.Float64bits(old), math.Float64bits(new))
}

// SafeMap provides a thread-safe map
type SafeMap struct {
	mu   sync.RWMutex
	data map[string]interface{}
}

// NewSafeMap creates a new thread-safe map
func NewSafeMap() *SafeMap {
	return &SafeMap{
		data: make(map[string]interface{}),
	}
}

// Get retrieves a value from the map
func (m *SafeMap) Get(key string) (interface{}, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	val, ok := m.data[key]
	return val, ok
}

// Set sets a value in the map
func (m *SafeMap) Set(key string, value interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = value
}

// Delete removes a value from the map
func (m *SafeMap) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
}

// Len returns the number of items in the map
func (m *SafeMap) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.data)
}

// RingBuffer provides a circular buffer
type RingBuffer struct {
	data  []interface{}
	size  int
	head  int
	tail  int
	count int
	mu    sync.Mutex
}

// NewRingBuffer creates a new ring buffer
func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		data: make([]interface{}, size),
		size: size,
	}
}

// Push adds an item to the buffer
func (rb *RingBuffer) Push(item interface{}) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	
	rb.data[rb.tail] = item
	rb.tail = (rb.tail + 1) % rb.size
	
	if rb.count < rb.size {
		rb.count++
	} else {
		rb.head = (rb.head + 1) % rb.size
	}
}

// Pop removes and returns an item from the buffer
func (rb *RingBuffer) Pop() (interface{}, bool) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	
	if rb.count == 0 {
		return nil, false
	}
	
	item := rb.data[rb.head]
	rb.head = (rb.head + 1) % rb.size
	rb.count--
	
	return item, true
}

// GetAll returns all items in the buffer
func (rb *RingBuffer) GetAll() []interface{} {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	
	result := make([]interface{}, rb.count)
	for i := 0; i < rb.count; i++ {
		idx := (rb.head + i) % rb.size
		result[i] = rb.data[idx]
	}
	
	return result
}

// GenerateNonce generates a random nonce
func GenerateNonce() uint64 {
	var nonce uint64
	binary.Read(rand.Reader, binary.LittleEndian, &nonce)
	return nonce
}

// GenerateRandomBytes generates random bytes
func GenerateRandomBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

// GenerateRandomHex generates a random hex string
func GenerateRandomHex(n int) string {
	return hex.EncodeToString(GenerateRandomBytes(n))
}

// FormatHashrate formats hashrate for display
func FormatHashrate(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"}
	
	if hashrate == 0 {
		return "0 H/s"
	}
	
	unitIndex := 0
	for hashrate >= 1000 && unitIndex < len(units)-1 {
		hashrate /= 1000
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f %s", hashrate, units[unitIndex])
}

// FormatDuration formats a duration for display
func FormatDuration(d time.Duration) string {
	days := int(d.Hours() / 24)
	hours := int(d.Hours()) % 24
	minutes := int(d.Minutes()) % 60
	seconds := int(d.Seconds()) % 60
	
	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm %ds", days, hours, minutes, seconds)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm %ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}

// FormatBytes formats bytes for display
func FormatBytes(bytes uint64) string {
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	
	if bytes == 0 {
		return "0 B"
	}
	
	unitIndex := 0
	size := float64(bytes)
	
	for size >= 1024 && unitIndex < len(units)-1 {
		size /= 1024
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f %s", size, units[unitIndex])
}

// GetLocalIP returns the local IP address
func GetLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	
	return "127.0.0.1"
}

// GetExternalIP attempts to get the external IP address
func GetExternalIP() string {
	// This is a simplified version
	// In production, query an external service
	return GetLocalIP()
}

// GetSystemInfo returns system information
func GetSystemInfo() map[string]interface{} {
	info := make(map[string]interface{})
	
	info["os"] = runtime.GOOS
	info["arch"] = runtime.GOARCH
	info["cpus"] = runtime.NumCPU()
	info["go_version"] = runtime.Version()
	info["goroutines"] = runtime.NumGoroutine()
	
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	info["memory"] = map[string]interface{}{
		"alloc":      FormatBytes(m.Alloc),
		"total":      FormatBytes(m.TotalAlloc),
		"sys":        FormatBytes(m.Sys),
		"gc_runs":    m.NumGC,
		"goroutines": runtime.NumGoroutine(),
	}
	
	return info
}

// FileExists checks if a file exists
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return !os.IsNotExist(err)
}

// CreateDirIfNotExist creates a directory if it doesn't exist
func CreateDirIfNotExist(path string) error {
	if !FileExists(path) {
		return os.MkdirAll(path, 0755)
	}
	return nil
}

// GetExecutablePath returns the path of the executable
func GetExecutablePath() string {
	ex, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(ex)
}

// GetDataPath returns the data directory path
func GetDataPath() string {
	// Check environment variable first
	if dataPath := os.Getenv("OTEDAMA_DATA_PATH"); dataPath != "" {
		return dataPath
	}
	
	// Use executable directory
	return filepath.Join(GetExecutablePath(), "data")
}

// GetConfigPath returns the config directory path
func GetConfigPath() string {
	// Check environment variable first
	if configPath := os.Getenv("OTEDAMA_CONFIG_PATH"); configPath != "" {
		return configPath
	}
	
	// Use executable directory
	return GetExecutablePath()
}

// ParsePoolURL parses a mining pool URL
func ParsePoolURL(url string) (scheme, host, port string, err error) {
	// Format: stratum+tcp://host:port or stratum+ssl://host:port
	parts := strings.Split(url, "://")
	if len(parts) != 2 {
		return "", "", "", fmt.Errorf("invalid pool URL format")
	}
	
	scheme = parts[0]
	
	// Split host and port
	hostPort := parts[1]
	host, port, err = net.SplitHostPort(hostPort)
	if err != nil {
		// No port specified, use default
		host = hostPort
		switch scheme {
		case "stratum+tcp":
			port = "3333"
		case "stratum+ssl", "stratum+tls":
			port = "3443"
		default:
			port = "3333"
		}
	}
	
	return scheme, host, port, nil
}

// Retry executes a function with exponential backoff
func Retry(fn func() error, maxRetries int, initialDelay time.Duration) error {
	var lastErr error
	delay := initialDelay
	
	for i := 0; i < maxRetries; i++ {
		if err := fn(); err == nil {
			return nil
		} else {
			lastErr = err
		}
		
		if i < maxRetries-1 {
			time.Sleep(delay)
			delay *= 2
		}
	}
	
	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

// MinInt returns the minimum of two integers
func MinInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// MaxInt returns the maximum of two integers
func MaxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// MinUint64 returns the minimum of two uint64
func MinUint64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}

// MaxUint64 returns the maximum of two uint64
func MaxUint64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}

// ClampFloat64 clamps a float64 value between min and max
func ClampFloat64(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// RoundFloat64 rounds a float64 to n decimal places
func RoundFloat64(value float64, decimals int) float64 {
	multiplier := math.Pow(10, float64(decimals))
	return math.Round(value*multiplier) / multiplier
}

// CalculatePercentage calculates percentage
func CalculatePercentage(value, total float64) float64 {
	if total == 0 {
		return 0
	}
	return (value / total) * 100
}

// MovingAverage calculates moving average
type MovingAverage struct {
	window   int
	values   []float64
	sum      float64
	position int
	filled   bool
}

// NewMovingAverage creates a new moving average calculator
func NewMovingAverage(window int) *MovingAverage {
	return &MovingAverage{
		window: window,
		values: make([]float64, window),
	}
}

// Add adds a value to the moving average
func (ma *MovingAverage) Add(value float64) {
	if ma.filled {
		ma.sum -= ma.values[ma.position]
	}
	
	ma.values[ma.position] = value
	ma.sum += value
	ma.position = (ma.position + 1) % ma.window
	
	if ma.position == 0 {
		ma.filled = true
	}
}

// Average returns the current moving average
func (ma *MovingAverage) Average() float64 {
	count := ma.window
	if !ma.filled {
		count = ma.position
	}
	
	if count == 0 {
		return 0
	}
	
	return ma.sum / float64(count)
}

// Throttle provides function throttling
type Throttle struct {
	mu       sync.Mutex
	lastCall time.Time
	interval time.Duration
}

// NewThrottle creates a new throttle
func NewThrottle(interval time.Duration) *Throttle {
	return &Throttle{
		interval: interval,
	}
}

// Do executes the function if enough time has passed
func (t *Throttle) Do(fn func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	
	now := time.Now()
	if now.Sub(t.lastCall) >= t.interval {
		t.lastCall = now
		fn()
	}
}

// Debounce provides function debouncing
type Debounce struct {
	mu       sync.Mutex
	timer    *time.Timer
	duration time.Duration
}

// NewDebounce creates a new debounce
func NewDebounce(duration time.Duration) *Debounce {
	return &Debounce{
		duration: duration,
	}
}

// Do schedules the function to run after the duration
func (d *Debounce) Do(fn func()) {
	d.mu.Lock()
	defer d.mu.Unlock()
	
	if d.timer != nil {
		d.timer.Stop()
	}
	
	d.timer = time.AfterFunc(d.duration, fn)
}

// Cancel cancels the pending function
func (d *Debounce) Cancel() {
	d.mu.Lock()
	defer d.mu.Unlock()
	
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
}
