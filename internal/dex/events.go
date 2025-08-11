package dex

import (
	"sync"
)

// EventEmitter handles event emission
type EventEmitter struct {
	listeners map[string][]chan interface{}
	events    chan interface{}
	mu        sync.RWMutex
}

// NewEventEmitter creates a new event emitter
func NewEventEmitter() *EventEmitter {
	return &EventEmitter{
		listeners: make(map[string][]chan interface{}),
		events:    make(chan interface{}, 1000),
	}
}

// Emit emits an event
func (e *EventEmitter) Emit(event interface{}) {
	select {
	case e.events <- event:
		// Event sent
	default:
		// Channel full, drop event
		// In production, handle this better
	}
	
	// Notify type-specific listeners
	e.notifyListeners(event)
}

// Events returns the events channel
func (e *EventEmitter) Events() <-chan interface{} {
	return e.events
}

// Subscribe subscribes to events of a specific type
func (e *EventEmitter) Subscribe(eventType string) <-chan interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	ch := make(chan interface{}, 100)
	e.listeners[eventType] = append(e.listeners[eventType], ch)
	
	return ch
}

// Unsubscribe removes a subscription
func (e *EventEmitter) Unsubscribe(eventType string, ch <-chan interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	listeners := e.listeners[eventType]
	for i, listener := range listeners {
		if listener == ch {
			// Remove from slice
			e.listeners[eventType] = append(listeners[:i], listeners[i+1:]...)
			close(listener)
			break
		}
	}
}

// notifyListeners notifies type-specific listeners
func (e *EventEmitter) notifyListeners(event interface{}) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	eventType := getEventType(event)
	listeners := e.listeners[eventType]
	
	for _, listener := range listeners {
		select {
		case listener <- event:
			// Event sent
		default:
			// Listener channel full, skip
		}
	}
}

// getEventType returns the type name of an event
func getEventType(event interface{}) string {
	switch event.(type) {
	case EventSwapExecuted:
		return "swap_executed"
	case EventLiquidityAdded:
		return "liquidity_added"
	case EventLiquidityRemoved:
		return "liquidity_removed"
	case EventPairCreated:
		return "pair_created"
	case EventOrderPlaced:
		return "order_placed"
	case EventOrderExecuted:
		return "order_executed"
	case EventOrderCancelled:
		return "order_cancelled"
	default:
		return "unknown"
	}
}