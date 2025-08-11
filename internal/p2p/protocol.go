package p2p

import (
	"context"
	"time"

	"github.com/libp2p/go-libp2p/core/protocol"
)

// Protocol represents a P2P protocol ID
type Protocol protocol.ID

const (
	// Protocol IDs
	MiningProtocol Protocol = "/otedama/mining/1.0.0"
	SyncProtocol   Protocol = "/otedama/sync/1.0.0"
	DiscoveryProtocol Protocol = "/otedama/discovery/1.0.0"
)

// P2PMessage represents a message exchanged over P2P
type P2PMessage struct {
	Type      P2PMessageType `json:"type"`
	Payload   []byte      `json:"payload"`
	Timestamp time.Time   `json:"timestamp"`
	From      string      `json:"from"`
	To        string      `json:"to,omitempty"`
	MessageID string      `json:"message_id"`
}

// P2PMessageType represents the type of P2P message  
type P2PMessageType string

const (
	// Message types
	P2PMessageTypeBlockFound    P2PMessageType = "block_found"
	P2PMessageTypeShareSubmit   P2PMessageType = "share_submit"
	P2PMessageTypeWorkRequest   P2PMessageType = "work_request"
	P2PMessageTypeWorkResponse  P2PMessageType = "work_response"
	P2PMessageTypePeerDiscovery P2PMessageType = "peer_discovery"
	P2PMessageTypePing          P2PMessageType = "ping"
	P2PMessageTypePong          P2PMessageType = "pong"
	P2PMessageTypeSync          P2PMessageType = "sync"
	P2PMessageTypeSyncResponse  P2PMessageType = "sync_response"
)

// Handler represents a message handler function
type Handler func(ctx context.Context, msg *P2PMessage) error

// ProtocolHandler manages protocol handlers
type ProtocolHandler struct {
	handlers map[P2PMessageType]Handler
}

// NewProtocolHandler creates a new protocol handler
func NewProtocolHandler() *ProtocolHandler {
	return &ProtocolHandler{
		handlers: make(map[P2PMessageType]Handler),
	}
}

// RegisterHandler registers a handler for a message type
func (ph *ProtocolHandler) RegisterHandler(msgType P2PMessageType, handler Handler) {
	ph.handlers[msgType] = handler
}

// Handle processes a message
func (ph *ProtocolHandler) Handle(ctx context.Context, msg *P2PMessage) error {
	handler, exists := ph.handlers[msg.Type]
	if !exists {
		return nil // No handler for this message type
	}
	return handler(ctx, msg)
}