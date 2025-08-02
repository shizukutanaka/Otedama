package p2p

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"go.uber.org/zap"
)

// UDPTransport implements DHT transport over UDP
type UDPTransport struct {
	logger      *zap.Logger
	conn        *net.UDPConn
	handler     func(Message, net.Addr)
	running     bool
	mu          sync.RWMutex
	stopChan    chan struct{}
}

// NewUDPTransport creates a new UDP transport
func NewUDPTransport(logger *zap.Logger, handler func(Message, net.Addr)) *UDPTransport {
	return &UDPTransport{
		logger:   logger,
		handler:  handler,
		stopChan: make(chan struct{}),
	}
}

// Listen starts listening on the specified address
func (t *UDPTransport) Listen(addr string) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return err
	}
	
	t.mu.Lock()
	t.conn = conn
	t.running = true
	t.mu.Unlock()
	
	// Start receive loop
	go t.receiveLoop()
	
	t.logger.Info("UDP transport listening", zap.String("address", addr))
	return nil
}

// SendMessage sends a message to the specified address
func (t *UDPTransport) SendMessage(addr string, msg Message) error {
	t.mu.RLock()
	conn := t.conn
	t.mu.RUnlock()
	
	if conn == nil {
		return fmt.Errorf("transport not started")
	}
	
	// Encode message
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	// Resolve address
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	
	// Send message
	_, err = conn.WriteToUDP(data, udpAddr)
	return err
}

// Close stops the transport
func (t *UDPTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	
	if !t.running {
		return nil
	}
	
	t.running = false
	close(t.stopChan)
	
	if t.conn != nil {
		return t.conn.Close()
	}
	
	return nil
}

func (t *UDPTransport) receiveLoop() {
	buffer := make([]byte, 65536) // Max UDP packet size
	
	for {
		select {
		case <-t.stopChan:
			return
		default:
		}
		
		// Set read deadline to allow periodic checks
		t.conn.SetReadDeadline(time.Now().Add(time.Second))
		
		n, addr, err := t.conn.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			if !t.running {
				return
			}
			t.logger.Error("Failed to read UDP packet", zap.Error(err))
			continue
		}
		
		// Decode message
		var msg Message
		if err := json.Unmarshal(buffer[:n], &msg); err != nil {
			t.logger.Warn("Failed to decode message", zap.Error(err))
			continue
		}
		
		// Handle message in goroutine
		go t.handler(msg, addr)
	}
}