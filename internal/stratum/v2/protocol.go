package v2

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Stratum V2 Protocol Implementation
// Following Bitcoin Mining Protocol v2 specification
// Rob Pike's simplicity with John Carmack's performance

// MessageType defines Stratum v2 message types
type MessageType uint8

const (
	// Common messages
	MsgSetupConnection           MessageType = 0x00
	MsgSetupConnectionSuccess    MessageType = 0x01
	MsgSetupConnectionError      MessageType = 0x02
	MsgChannelEndpointChanged    MessageType = 0x03
	
	// Mining protocol messages
	MsgOpenStandardMiningChannel MessageType = 0x10
	MsgOpenMiningChannelSuccess  MessageType = 0x11
	MsgOpenMiningChannelError    MessageType = 0x12
	MsgUpdateChannel             MessageType = 0x13
	MsgUpdateChannelError        MessageType = 0x14
	MsgCloseChannel              MessageType = 0x15
	MsgSetExtranoncePrefix       MessageType = 0x16
	
	// Job messages
	MsgNewMiningJob              MessageType = 0x1E
	MsgSetNewPrevHash            MessageType = 0x1F
	MsgSubmitSharesStandard      MessageType = 0x20
	MsgSubmitSharesSuccess       MessageType = 0x21
	MsgSubmitSharesError         MessageType = 0x22
	
	// Template messages
	MsgSetCustomMiningJob        MessageType = 0x23
	MsgCommitMiningJob           MessageType = 0x24
	MsgCommitMiningJobSuccess    MessageType = 0x25
	MsgCommitMiningJobError      MessageType = 0x26
)

// Frame represents a Stratum v2 frame
type Frame struct {
	Header  FrameHeader
	Payload []byte
}

// FrameHeader contains frame metadata
type FrameHeader struct {
	ExtensionType uint16      // 2 bytes
	MessageType   MessageType // 1 byte
	MessageLength uint32      // 3 bytes (24-bit)
}

// SetupConnection message
type SetupConnection struct {
	Protocol         uint8    `json:"protocol"`
	MinVersion       uint16   `json:"min_version"`
	MaxVersion       uint16   `json:"max_version"`
	Flags            uint32   `json:"flags"`
	EndpointHost     string   `json:"endpoint_host"`
	EndpointPort     uint16   `json:"endpoint_port"`
	Vendor           string   `json:"vendor"`
	HardwareVersion  string   `json:"hardware_version"`
	FirmwareVersion  string   `json:"firmware_version"`
	DeviceID         string   `json:"device_id"`
}

// SetupConnectionSuccess response
type SetupConnectionSuccess struct {
	UsedVersion uint16 `json:"used_version"`
	Flags       uint32 `json:"flags"`
}

// OpenStandardMiningChannel message
type OpenStandardMiningChannel struct {
	RequestID              uint32  `json:"request_id"`
	UserIdentity           string  `json:"user_identity"`
	NominalHashRate        float32 `json:"nominal_hash_rate"`
	MaxTarget              [32]byte `json:"max_target"`
}

// OpenMiningChannelSuccess response
type OpenMiningChannelSuccess struct {
	RequestID              uint32   `json:"request_id"`
	ChannelID              uint32   `json:"channel_id"`
	Target                 [32]byte `json:"target"`
	ExtranoncePrefix       []byte   `json:"extranonce_prefix"`
	GroupChannelID         uint32   `json:"group_channel_id"`
}

// NewMiningJob message
type NewMiningJob struct {
	ChannelID      uint32   `json:"channel_id"`
	JobID          uint32   `json:"job_id"`
	FutureJob      bool     `json:"future_job"`
	Version        uint32   `json:"version"`
	VersionRolling bool     `json:"version_rolling"`
	PrevHash       [32]byte `json:"prev_hash"`
	MerkleRoot     [32]byte `json:"merkle_root"`
}

// SubmitSharesStandard message
type SubmitSharesStandard struct {
	ChannelID   uint32 `json:"channel_id"`
	Sequence    uint32 `json:"sequence"`
	JobID       uint32 `json:"job_id"`
	Nonce       uint32 `json:"nonce"`
	NTime       uint32 `json:"ntime"`
	Version     uint32 `json:"version"`
}

// Protocol handler
type ProtocolHandler struct {
	version        uint16
	flags          uint32
	maxMessageSize uint32
	mu             sync.RWMutex
}

// NewProtocolHandler creates a new Stratum v2 protocol handler
func NewProtocolHandler() *ProtocolHandler {
	return &ProtocolHandler{
		version:        2,
		maxMessageSize: 1024 * 1024, // 1MB max message
	}
}

// SerializeFrame serializes a frame for transmission
func (ph *ProtocolHandler) SerializeFrame(msgType MessageType, payload []byte) ([]byte, error) {
	if len(payload) > 0xFFFFFF { // 24-bit max
		return nil, errors.New("payload too large")
	}
	
	frame := make([]byte, 6+len(payload))
	
	// Extension type (2 bytes)
	binary.LittleEndian.PutUint16(frame[0:2], 0)
	
	// Message type (1 byte)
	frame[2] = byte(msgType)
	
	// Message length (3 bytes, little-endian)
	length := uint32(len(payload))
	frame[3] = byte(length)
	frame[4] = byte(length >> 8)
	frame[5] = byte(length >> 16)
	
	// Payload
	copy(frame[6:], payload)
	
	return frame, nil
}

// DeserializeFrame deserializes a frame from bytes
func (ph *ProtocolHandler) DeserializeFrame(data []byte) (*Frame, error) {
	if len(data) < 6 {
		return nil, errors.New("frame too short")
	}
	
	header := FrameHeader{
		ExtensionType: binary.LittleEndian.Uint16(data[0:2]),
		MessageType:   MessageType(data[2]),
		MessageLength: uint32(data[3]) | (uint32(data[4]) << 8) | (uint32(data[5]) << 16),
	}
	
	if header.MessageLength > ph.maxMessageSize {
		return nil, errors.New("message too large")
	}
	
	if len(data) < 6+int(header.MessageLength) {
		return nil, errors.New("incomplete frame")
	}
	
	return &Frame{
		Header:  header,
		Payload: data[6 : 6+header.MessageLength],
	}, nil
}

// FrameReader reads Stratum v2 frames from a stream
type FrameReader struct {
	reader io.Reader
	buffer []byte
	pos    int
}

// NewFrameReader creates a new frame reader
func NewFrameReader(r io.Reader) *FrameReader {
	return &FrameReader{
		reader: r,
		buffer: make([]byte, 1024*1024), // 1MB buffer
	}
}

// ReadFrame reads the next frame
func (fr *FrameReader) ReadFrame() (*Frame, error) {
	// Read header
	header := make([]byte, 6)
	if _, err := io.ReadFull(fr.reader, header); err != nil {
		return nil, err
	}
	
	// Parse header
	frameHeader := FrameHeader{
		ExtensionType: binary.LittleEndian.Uint16(header[0:2]),
		MessageType:   MessageType(header[2]),
		MessageLength: uint32(header[3]) | (uint32(header[4]) << 8) | (uint32(header[5]) << 16),
	}
	
	// Read payload
	payload := make([]byte, frameHeader.MessageLength)
	if _, err := io.ReadFull(fr.reader, payload); err != nil {
		return nil, err
	}
	
	return &Frame{
		Header:  frameHeader,
		Payload: payload,
	}, nil
}

// FrameWriter writes Stratum v2 frames to a stream
type FrameWriter struct {
	writer io.Writer
	mu     sync.Mutex
}

// NewFrameWriter creates a new frame writer
func NewFrameWriter(w io.Writer) *FrameWriter {
	return &FrameWriter{
		writer: w,
	}
}

// WriteFrame writes a frame
func (fw *FrameWriter) WriteFrame(frame *Frame) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	
	// Write header
	header := make([]byte, 6)
	binary.LittleEndian.PutUint16(header[0:2], frame.Header.ExtensionType)
	header[2] = byte(frame.Header.MessageType)
	header[3] = byte(frame.Header.MessageLength)
	header[4] = byte(frame.Header.MessageLength >> 8)
	header[5] = byte(frame.Header.MessageLength >> 16)
	
	if _, err := fw.writer.Write(header); err != nil {
		return err
	}
	
	// Write payload
	if _, err := fw.writer.Write(frame.Payload); err != nil {
		return err
	}
	
	return nil
}

// Crypto helpers

// GenerateJobID generates a unique job ID
func GenerateJobID() uint32 {
	var id [4]byte
	rand.Read(id[:])
	return binary.LittleEndian.Uint32(id[:])
}

// GenerateChannelID generates a unique channel ID
func GenerateChannelID() uint32 {
	var id [4]byte
	rand.Read(id[:])
	return binary.LittleEndian.Uint32(id[:]) & 0x7FFFFFFF // Clear MSB
}

// GenerateExtranoncePrefix generates extranonce prefix
func GenerateExtranoncePrefix(size int) []byte {
	prefix := make([]byte, size)
	rand.Read(prefix)
	return prefix
}

// DifficultyToTarget converts difficulty to target
func DifficultyToTarget(difficulty float64) [32]byte {
	// Maximum target (difficulty 1)
	maxTarget := "00000000ffff0000000000000000000000000000000000000000000000000000"
	maxBytes, _ := hex.DecodeString(maxTarget)
	
	// Calculate actual target
	var target [32]byte
	// Simplified calculation - in production use proper big int math
	for i := 0; i < 32; i++ {
		target[i] = byte(float64(maxBytes[i]) / difficulty)
	}
	
	return target
}

// ValidateShare validates a submitted share
func ValidateShare(share *SubmitSharesStandard, job *NewMiningJob, target [32]byte) error {
	// Validate job ID
	if share.JobID != job.JobID {
		return errors.New("invalid job ID")
	}
	
	// Build block header
	header := make([]byte, 80)
	binary.LittleEndian.PutUint32(header[0:4], share.Version)
	copy(header[4:36], job.PrevHash[:])
	copy(header[36:68], job.MerkleRoot[:])
	binary.LittleEndian.PutUint32(header[68:72], share.NTime)
	// Bits would go here in real implementation
	binary.LittleEndian.PutUint32(header[76:80], share.Nonce)
	
	// Calculate hash (simplified - real implementation would use double SHA256)
	// hash := sha256d(header)
	
	// Check against target
	// if !hashMeetsTarget(hash, target) {
	//     return errors.New("hash does not meet target")
	// }
	
	return nil
}

// Error types
var (
	ErrInvalidProtocol = errors.New("invalid protocol version")
	ErrChannelClosed   = errors.New("channel closed")
	ErrUnauthorized    = errors.New("unauthorized")
	ErrInvalidShare    = errors.New("invalid share")
)

// Protocol flags
const (
	FlagRequiresStandardJobs  uint32 = 1 << 0
	FlagRequiresWorkSelection uint32 = 1 << 1
	FlagRequiresVersionRolling uint32 = 1 << 2
)

// FormatHashRate formats hash rate for display
func FormatHashRate(hashRate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"}
	unitIndex := 0
	
	for hashRate >= 1000 && unitIndex < len(units)-1 {
		hashRate /= 1000
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f %s", hashRate, units[unitIndex])
}