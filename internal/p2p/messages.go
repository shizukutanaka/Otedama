package p2p

import (
	"encoding/json"
	"fmt"
	"time"
)

// Message payloads for specific message types

// SharePayload represents a share submission message
type SharePayload struct {
	MinerID    string    `json:"miner_id"`
	JobID      string    `json:"job_id"`
	Nonce      uint64    `json:"nonce"`
	Difficulty float64   `json:"difficulty"`
	Hash       string    `json:"hash"`
	Timestamp  time.Time `json:"timestamp"`
}

// JobPayload represents a mining job message
type JobPayload struct {
	JobID       string    `json:"job_id"`
	BlockHeight uint64    `json:"block_height"`
	PrevHash    string    `json:"prev_hash"`
	MerkleRoot  string    `json:"merkle_root"`
	Target      string    `json:"target"`
	Difficulty  float64   `json:"difficulty"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// BlockPayload represents a new block announcement
type BlockPayload struct {
	BlockHash   string    `json:"block_hash"`
	BlockHeight uint64    `json:"block_height"`
	PrevHash    string    `json:"prev_hash"`
	MerkleRoot  string    `json:"merkle_root"`
	Nonce       uint64    `json:"nonce"`
	Timestamp   time.Time `json:"timestamp"`
	MinerID     string    `json:"miner_id"`
	TxCount     int       `json:"tx_count"`
}

// LedgerPayload represents a reward ledger message
type LedgerPayload struct {
	BlockHash   string             `json:"block_hash"`
	BlockHeight uint64             `json:"block_height"`
	TotalReward uint64             `json:"total_reward"`
	Shares      map[string]float64 `json:"shares"`
	Rewards     map[string]uint64  `json:"rewards"`
	Creator     string             `json:"creator"`
	Checksum    string             `json:"checksum"`
}

// TxPayload represents a transaction message
type TxPayload struct {
	TxID      string    `json:"tx_id"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Amount    uint64    `json:"amount"`
	Fee       uint64    `json:"fee"`
	Nonce     uint64    `json:"nonce"`
	Timestamp time.Time `json:"timestamp"`
	Signature []byte    `json:"signature"`
}

// PeerListPayload represents a peer list update
type PeerListPayload struct {
	Peers []PeerInfo `json:"peers"`
}

// PeerInfo represents basic peer information
type PeerInfo struct {
	ID         string    `json:"id"`
	Address    string    `json:"address"`
	Version    string    `json:"version"`
	LastSeen   time.Time `json:"last_seen"`
	TrustLevel float64   `json:"trust_level"`
}

// HandshakePayload represents initial handshake data
type HandshakePayload struct {
	NodeID      string    `json:"node_id"`
	Version     string    `json:"version"`
	Height      uint64    `json:"height"`
	Timestamp   time.Time `json:"timestamp"`
	Capabilities []string  `json:"capabilities"`
}

// SyncRequestPayload represents a sync request
type SyncRequestPayload struct {
	FromHeight uint64 `json:"from_height"`
	ToHeight   uint64 `json:"to_height"`
	DataType   string `json:"data_type"` // "blocks", "ledgers", "shares"
}

// SyncResponsePayload represents a sync response
type SyncResponsePayload struct {
	FromHeight uint64          `json:"from_height"`
	ToHeight   uint64          `json:"to_height"`
	DataType   string          `json:"data_type"`
	Data       json.RawMessage `json:"data"`
}

// MessageBuilder provides helper methods to build P2P messages
type MessageBuilder struct {
	protocol *Protocol
}

// NewMessageBuilder creates a new message builder
func NewMessageBuilder(protocol *Protocol) *MessageBuilder {
	return &MessageBuilder{
		protocol: protocol,
	}
}

// BuildShareMessage builds a share submission message
func (mb *MessageBuilder) BuildShareMessage(minerID, jobID string, nonce uint64, difficulty float64, hash string) (*SharePayload, error) {
	return &SharePayload{
		MinerID:    minerID,
		JobID:      jobID,
		Nonce:      nonce,
		Difficulty: difficulty,
		Hash:       hash,
		Timestamp:  time.Now(),
	}, nil
}

// BuildJobMessage builds a mining job message
func (mb *MessageBuilder) BuildJobMessage(job MiningJob) (*JobPayload, error) {
	return &JobPayload{
		JobID:       job.JobID,
		BlockHeight: job.BlockHeight,
		PrevHash:    job.PrevHash,
		MerkleRoot:  job.MerkleRoot,
		Target:      job.Target,
		Difficulty:  job.Difficulty,
		ExpiresAt:   job.ExpiresAt,
	}, nil
}

// BuildBlockMessage builds a block announcement message
func (mb *MessageBuilder) BuildBlockMessage(block Block) (*BlockPayload, error) {
	return &BlockPayload{
		BlockHash:   block.Hash,
		BlockHeight: block.Height,
		PrevHash:    block.PrevHash,
		MerkleRoot:  block.MerkleRoot,
		Nonce:       block.Nonce,
		Timestamp:   block.Timestamp,
		MinerID:     block.MinerID,
		TxCount:     len(block.Transactions),
	}, nil
}

// BuildHandshakeMessage builds a handshake message
func (mb *MessageBuilder) BuildHandshakeMessage(nodeID, version string, height uint64) (*HandshakePayload, error) {
	return &HandshakePayload{
		NodeID:    nodeID,
		Version:   version,
		Height:    height,
		Timestamp: time.Now(),
		Capabilities: []string{
			"mining",
			"validation",
			"ledger_sync",
			"tx_relay",
		},
	}, nil
}

// ParseMessage parses a P2P message payload based on type
func ParseMessage(msgType MessageType, payload []byte) (interface{}, error) {
	switch msgType {
	case ShareMessage:
		var share SharePayload
		if err := json.Unmarshal(payload, &share); err != nil {
			return nil, err
		}
		return &share, nil
		
	case JobMessage:
		var job JobPayload
		if err := json.Unmarshal(payload, &job); err != nil {
			return nil, err
		}
		return &job, nil
		
	case BlockMessage:
		var block BlockPayload
		if err := json.Unmarshal(payload, &block); err != nil {
			return nil, err
		}
		return &block, nil
		
	case LedgerMessage:
		var ledger LedgerPayload
		if err := json.Unmarshal(payload, &ledger); err != nil {
			return nil, err
		}
		return &ledger, nil
		
	case TxMessage:
		var tx TxPayload
		if err := json.Unmarshal(payload, &tx); err != nil {
			return nil, err
		}
		return &tx, nil
		
	case PeerListMessage:
		var peerList PeerListPayload
		if err := json.Unmarshal(payload, &peerList); err != nil {
			return nil, err
		}
		return &peerList, nil
		
	case HandshakeMessage:
		var handshake HandshakePayload
		if err := json.Unmarshal(payload, &handshake); err != nil {
			return nil, err
		}
		return &handshake, nil
		
	case SyncMessage:
		// Try sync request first
		var syncReq SyncRequestPayload
		if err := json.Unmarshal(payload, &syncReq); err == nil {
			return &syncReq, nil
		}
		
		// Try sync response
		var syncResp SyncResponsePayload
		if err := json.Unmarshal(payload, &syncResp); err != nil {
			return nil, err
		}
		return &syncResp, nil
		
	default:
		return payload, nil
	}
}

// ValidateMessage validates a message payload
func ValidateMessage(msgType MessageType, payload interface{}) error {
	switch msgType {
	case ShareMessage:
		share, ok := payload.(*SharePayload)
		if !ok {
			return fmt.Errorf("invalid share payload type")
		}
		if share.MinerID == "" {
			return fmt.Errorf("share missing miner ID")
		}
		if share.JobID == "" {
			return fmt.Errorf("share missing job ID")
		}
		if share.Difficulty <= 0 {
			return fmt.Errorf("invalid share difficulty")
		}
		
	case JobMessage:
		job, ok := payload.(*JobPayload)
		if !ok {
			return fmt.Errorf("invalid job payload type")
		}
		if job.JobID == "" {
			return fmt.Errorf("job missing ID")
		}
		if job.Target == "" {
			return fmt.Errorf("job missing target")
		}
		if job.Difficulty <= 0 {
			return fmt.Errorf("invalid job difficulty")
		}
		
	case BlockMessage:
		block, ok := payload.(*BlockPayload)
		if !ok {
			return fmt.Errorf("invalid block payload type")
		}
		if block.BlockHash == "" {
			return fmt.Errorf("block missing hash")
		}
		if block.PrevHash == "" && block.BlockHeight > 0 {
			return fmt.Errorf("block missing previous hash")
		}
		
	case LedgerMessage:
		ledger, ok := payload.(*LedgerPayload)
		if !ok {
			return fmt.Errorf("invalid ledger payload type")
		}
		if ledger.BlockHash == "" {
			return fmt.Errorf("ledger missing block hash")
		}
		if ledger.Checksum == "" {
			return fmt.Errorf("ledger missing checksum")
		}
		if len(ledger.Shares) == 0 {
			return fmt.Errorf("ledger has no shares")
		}
		
	case TxMessage:
		tx, ok := payload.(*TxPayload)
		if !ok {
			return fmt.Errorf("invalid transaction payload type")
		}
		if tx.TxID == "" {
			return fmt.Errorf("transaction missing ID")
		}
		if tx.From == "" && tx.From != "coinbase" {
			return fmt.Errorf("transaction missing sender")
		}
		if tx.To == "" {
			return fmt.Errorf("transaction missing recipient")
		}
		if tx.Amount == 0 {
			return fmt.Errorf("transaction has zero amount")
		}
	}
	
	return nil
}

// Placeholder types for building messages
// These would be imported from their respective packages in a real implementation

type MiningJob struct {
	JobID       string
	BlockHeight uint64
	PrevHash    string
	MerkleRoot  string
	Target      string
	Difficulty  float64
	ExpiresAt   time.Time
}

type Block struct {
	Hash         string
	Height       uint64
	PrevHash     string
	MerkleRoot   string
	Nonce        uint64
	Timestamp    time.Time
	MinerID      string
	Transactions []string
}