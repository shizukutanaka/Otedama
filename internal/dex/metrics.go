package dex

import (
	"sync/atomic"
)

// Counter represents a metric counter
type Counter struct {
	name  string
	value int64
}

// NewCounter creates a new counter
func NewCounter(name string) Counter {
	return Counter{
		name:  name,
		value: 0,
	}
}

// Inc increments the counter
func (c *Counter) Inc() {
	atomic.AddInt64(&c.value, 1)
}

// Add adds a value to the counter
func (c *Counter) Add(delta float64) {
	atomic.AddInt64(&c.value, int64(delta))
}

// Value returns the current value
func (c *Counter) Value() int64 {
	return atomic.LoadInt64(&c.value)
}

// Gauge represents a metric gauge
type Gauge struct {
	name  string
	value int64
}

// NewGauge creates a new gauge
func NewGauge(name string) Gauge {
	return Gauge{
		name:  name,
		value: 0,
	}
}

// Set sets the gauge value
func (g *Gauge) Set(value float64) {
	atomic.StoreInt64(&g.value, int64(value))
}

// Inc increments the gauge
func (g *Gauge) Inc() {
	atomic.AddInt64(&g.value, 1)
}

// Dec decrements the gauge
func (g *Gauge) Dec() {
	atomic.AddInt64(&g.value, -1)
}

// Value returns the current value
func (g *Gauge) Value() int64 {
	return atomic.LoadInt64(&g.value)
}