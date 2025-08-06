package asic

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"go.uber.org/zap"
)

// FirmwareProtocol defines the interface for ASIC firmware communication
type FirmwareProtocol interface {
	Connect(address string, port int) error
	Disconnect() error
	IsConnected() bool
	
	// Low-level commands
	SendCommand(cmd Command) (*Response, error)
	ReadRegister(addr uint32) (uint32, error)
	WriteRegister(addr uint32, value uint32) error
	
	// Firmware operations
	GetFirmwareVersion() (string, error)
	UpdateFirmware(data []byte) error
	VerifyFirmware() error
	
	// Chain operations
	GetChainStatus(chainID int) (*ChainStatus, error)
	ConfigureChain(chainID int, config *ChainConfig) error
	
	// Work operations
	SendWorkPacket(packet *WorkPacket) error
	GetNonceResponse() (*NonceResponse, error)
}

// Command represents a low-level ASIC command
type Command struct {
	Opcode   uint8
	ChainID  uint8
	Register uint16
	Data     []byte
}

// Response represents a command response
type Response struct {
	Status   uint8
	ChainID  uint8
	Register uint16
	Data     []byte
}

// ChainStatus represents the status of a hash board chain
type ChainStatus struct {
	ChainID        int
	Enabled        bool
	ChipCount      int
	Temperature    float32
	Voltage        float32
	Current        float32
	Frequency      int
	HardwareErrors uint64
	LastNonce      uint32
	NonceCount     uint64
}

// ChainConfig represents chain configuration
type ChainConfig struct {
	Enabled    bool
	Frequency  int
	Voltage    float32
	CoreVoltage float32
	StartChip  int
	EndChip    int
}

// WorkPacket represents mining work for the ASIC
type WorkPacket struct {
	JobID      uint32
	Version    uint32
	PrevHash   [32]byte
	MerkleRoot [32]byte
	Timestamp  uint32
	Bits       uint32
	NonceStart uint32
	NonceEnd   uint32
	Target     [32]byte
}

// NonceResponse represents a found nonce
type NonceResponse struct {
	JobID     uint32
	ChainID   uint8
	ChipID    uint8
	Nonce     uint32
	Timestamp uint64
}

// BitmainProtocol implements the Bitmain firmware protocol
type BitmainProtocol struct {
	logger    *zap.Logger
	conn      net.Conn
	mu        sync.Mutex
	connected bool
	
	// Protocol version
	version   uint16
	
	// Response channel
	responses chan *Response
	
	// Nonce channel
	nonces    chan *NonceResponse
}

// Protocol constants
const (
	// Opcodes
	OpcodeReadReg     = 0x01
	OpcodeWriteReg    = 0x02
	OpcodeSendWork    = 0x03
	OpcodeGetStatus   = 0x04
	OpcodeSetConfig   = 0x05
	OpcodeGetNonce    = 0x06
	OpcodeReset       = 0x07
	OpcodeFirmwareVer = 0x08
	OpcodeFirmwareUpd = 0x09
	
	// Response codes
	ResponseOK        = 0x00
	ResponseError     = 0x01
	ResponseBusy      = 0x02
	ResponseTimeout   = 0x03
	
	// Protocol settings
	HeaderSize        = 8
	MaxPacketSize     = 4096
	CommandTimeout    = 5 * time.Second
)

// NewBitmainProtocol creates a new Bitmain firmware protocol handler
func NewBitmainProtocol(logger *zap.Logger) *BitmainProtocol {
	return &BitmainProtocol{
		logger:    logger,
		responses: make(chan *Response, 100),
		nonces:    make(chan *NonceResponse, 1000),
	}
}

// Connect establishes connection to the ASIC firmware
func (p *BitmainProtocol) Connect(address string, port int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if p.connected {
		return errors.New("already connected")
	}
	
	// Default firmware port
	if port == 0 {
		port = 4041 // Bitmain firmware port
	}
	
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, port), 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	p.conn = conn
	p.connected = true
	
	// Start response reader
	go p.responseReader()
	
	// Get firmware version
	version, err := p.GetFirmwareVersion()
	if err != nil {
		p.conn.Close()
		p.connected = false
		return fmt.Errorf("failed to get firmware version: %w", err)
	}
	
	p.logger.Info("Connected to ASIC firmware",
		zap.String("address", address),
		zap.Int("port", port),
		zap.String("version", version),
	)
	
	return nil
}

// Disconnect closes the firmware connection
func (p *BitmainProtocol) Disconnect() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if !p.connected {
		return nil
	}
	
	if p.conn != nil {
		p.conn.Close()
	}
	
	p.connected = false
	close(p.responses)
	close(p.nonces)
	
	return nil
}

// IsConnected returns connection status
func (p *BitmainProtocol) IsConnected() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.connected
}

// SendCommand sends a command and waits for response
func (p *BitmainProtocol) SendCommand(cmd Command) (*Response, error) {
	p.mu.Lock()
	if !p.connected {
		p.mu.Unlock()
		return nil, errors.New("not connected")
	}
	p.mu.Unlock()
	
	// Encode command
	packet := p.encodeCommand(cmd)
	
	// Send packet
	if err := p.sendPacket(packet); err != nil {
		return nil, err
	}
	
	// Wait for response
	select {
	case resp := <-p.responses:
		if resp.Register == cmd.Register {
			return resp, nil
		}
		return nil, errors.New("response mismatch")
	case <-time.After(CommandTimeout):
		return nil, errors.New("command timeout")
	}
}

// ReadRegister reads a register value
func (p *BitmainProtocol) ReadRegister(addr uint32) (uint32, error) {
	cmd := Command{
		Opcode:   OpcodeReadReg,
		Register: uint16(addr & 0xFFFF),
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return 0, err
	}
	
	if resp.Status != ResponseOK {
		return 0, fmt.Errorf("read register failed: status=%d", resp.Status)
	}
	
	if len(resp.Data) < 4 {
		return 0, errors.New("invalid response data")
	}
	
	return binary.LittleEndian.Uint32(resp.Data), nil
}

// WriteRegister writes a register value
func (p *BitmainProtocol) WriteRegister(addr uint32, value uint32) error {
	data := make([]byte, 4)
	binary.LittleEndian.PutUint32(data, value)
	
	cmd := Command{
		Opcode:   OpcodeWriteReg,
		Register: uint16(addr & 0xFFFF),
		Data:     data,
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return err
	}
	
	if resp.Status != ResponseOK {
		return fmt.Errorf("write register failed: status=%d", resp.Status)
	}
	
	return nil
}

// GetFirmwareVersion retrieves the firmware version
func (p *BitmainProtocol) GetFirmwareVersion() (string, error) {
	cmd := Command{
		Opcode: OpcodeFirmwareVer,
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return "", err
	}
	
	if resp.Status != ResponseOK {
		return "", fmt.Errorf("get firmware version failed: status=%d", resp.Status)
	}
	
	return string(bytes.TrimRight(resp.Data, "\x00")), nil
}

// UpdateFirmware updates the ASIC firmware
func (p *BitmainProtocol) UpdateFirmware(data []byte) error {
	// Calculate checksum
	checksum := sha256.Sum256(data)
	
	// Send firmware update command
	cmd := Command{
		Opcode: OpcodeFirmwareUpd,
		Data:   checksum[:],
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return err
	}
	
	if resp.Status != ResponseOK {
		return fmt.Errorf("firmware update init failed: status=%d", resp.Status)
	}
	
	// Send firmware data in chunks
	chunkSize := 1024
	for offset := 0; offset < len(data); offset += chunkSize {
		end := offset + chunkSize
		if end > len(data) {
			end = len(data)
		}
		
		chunk := data[offset:end]
		if err := p.sendFirmwareChunk(offset, chunk); err != nil {
			return fmt.Errorf("failed to send chunk at offset %d: %w", offset, err)
		}
		
		// Progress update
		progress := float64(offset) / float64(len(data)) * 100
		p.logger.Debug("Firmware update progress",
			zap.Float64("progress", progress),
			zap.Int("offset", offset),
			zap.Int("total", len(data)),
		)
	}
	
	// Verify firmware
	return p.VerifyFirmware()
}

// VerifyFirmware verifies the firmware integrity
func (p *BitmainProtocol) VerifyFirmware() error {
	// Implementation depends on specific ASIC model
	return nil
}

// GetChainStatus retrieves the status of a hash board chain
func (p *BitmainProtocol) GetChainStatus(chainID int) (*ChainStatus, error) {
	cmd := Command{
		Opcode:  OpcodeGetStatus,
		ChainID: uint8(chainID),
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return nil, err
	}
	
	if resp.Status != ResponseOK {
		return nil, fmt.Errorf("get chain status failed: status=%d", resp.Status)
	}
	
	// Parse status data
	status := &ChainStatus{
		ChainID: chainID,
	}
	
	if len(resp.Data) >= 32 {
		buf := bytes.NewReader(resp.Data)
		
		var flags uint32
		binary.Read(buf, binary.LittleEndian, &flags)
		status.Enabled = (flags & 0x01) != 0
		
		var chipCount uint32
		binary.Read(buf, binary.LittleEndian, &chipCount)
		status.ChipCount = int(chipCount)
		
		binary.Read(buf, binary.LittleEndian, &status.Temperature)
		binary.Read(buf, binary.LittleEndian, &status.Voltage)
		binary.Read(buf, binary.LittleEndian, &status.Current)
		
		var freq uint32
		binary.Read(buf, binary.LittleEndian, &freq)
		status.Frequency = int(freq)
		
		binary.Read(buf, binary.LittleEndian, &status.HardwareErrors)
		binary.Read(buf, binary.LittleEndian, &status.LastNonce)
		binary.Read(buf, binary.LittleEndian, &status.NonceCount)
	}
	
	return status, nil
}

// ConfigureChain configures a hash board chain
func (p *BitmainProtocol) ConfigureChain(chainID int, config *ChainConfig) error {
	// Encode configuration
	buf := new(bytes.Buffer)
	
	flags := uint32(0)
	if config.Enabled {
		flags |= 0x01
	}
	binary.Write(buf, binary.LittleEndian, flags)
	binary.Write(buf, binary.LittleEndian, uint32(config.Frequency))
	binary.Write(buf, binary.LittleEndian, config.Voltage)
	binary.Write(buf, binary.LittleEndian, config.CoreVoltage)
	binary.Write(buf, binary.LittleEndian, uint32(config.StartChip))
	binary.Write(buf, binary.LittleEndian, uint32(config.EndChip))
	
	cmd := Command{
		Opcode:  OpcodeSetConfig,
		ChainID: uint8(chainID),
		Data:    buf.Bytes(),
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return err
	}
	
	if resp.Status != ResponseOK {
		return fmt.Errorf("configure chain failed: status=%d", resp.Status)
	}
	
	return nil
}

// SendWorkPacket sends mining work to the ASIC
func (p *BitmainProtocol) SendWorkPacket(packet *WorkPacket) error {
	// Encode work packet
	buf := new(bytes.Buffer)
	
	binary.Write(buf, binary.LittleEndian, packet.JobID)
	binary.Write(buf, binary.LittleEndian, packet.Version)
	buf.Write(packet.PrevHash[:])
	buf.Write(packet.MerkleRoot[:])
	binary.Write(buf, binary.LittleEndian, packet.Timestamp)
	binary.Write(buf, binary.LittleEndian, packet.Bits)
	binary.Write(buf, binary.LittleEndian, packet.NonceStart)
	binary.Write(buf, binary.LittleEndian, packet.NonceEnd)
	buf.Write(packet.Target[:])
	
	cmd := Command{
		Opcode: OpcodeSendWork,
		Data:   buf.Bytes(),
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return err
	}
	
	if resp.Status != ResponseOK {
		return fmt.Errorf("send work failed: status=%d", resp.Status)
	}
	
	return nil
}

// GetNonceResponse retrieves a found nonce
func (p *BitmainProtocol) GetNonceResponse() (*NonceResponse, error) {
	select {
	case nonce := <-p.nonces:
		return nonce, nil
	case <-time.After(100 * time.Millisecond):
		return nil, errors.New("no nonce available")
	}
}

// Private methods

func (p *BitmainProtocol) encodeCommand(cmd Command) []byte {
	buf := new(bytes.Buffer)
	
	// Header
	buf.WriteByte(0xAA) // Magic byte
	buf.WriteByte(0x55) // Magic byte
	buf.WriteByte(cmd.Opcode)
	buf.WriteByte(cmd.ChainID)
	binary.Write(buf, binary.LittleEndian, cmd.Register)
	binary.Write(buf, binary.LittleEndian, uint16(len(cmd.Data)))
	
	// Data
	buf.Write(cmd.Data)
	
	// Checksum
	checksum := p.calculateChecksum(buf.Bytes())
	binary.Write(buf, binary.LittleEndian, checksum)
	
	return buf.Bytes()
}

func (p *BitmainProtocol) sendPacket(packet []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if err := p.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	
	_, err := p.conn.Write(packet)
	return err
}

func (p *BitmainProtocol) responseReader() {
	buf := make([]byte, MaxPacketSize)
	
	for p.connected {
		n, err := p.conn.Read(buf)
		if err != nil {
			if err != io.EOF {
				p.logger.Error("Read error", zap.Error(err))
			}
			break
		}
		
		if n >= HeaderSize {
			p.processResponse(buf[:n])
		}
	}
}

func (p *BitmainProtocol) processResponse(data []byte) {
	// Check magic bytes
	if data[0] != 0xAA || data[1] != 0x55 {
		return
	}
	
	// Parse header
	status := data[2]
	chainID := data[3]
	register := binary.LittleEndian.Uint16(data[4:6])
	dataLen := binary.LittleEndian.Uint16(data[6:8])
	
	// Validate packet size
	expectedSize := HeaderSize + int(dataLen) + 2 // +2 for checksum
	if len(data) < expectedSize {
		return
	}
	
	// Extract data
	respData := data[HeaderSize : HeaderSize+dataLen]
	
	// Check for nonce response
	if status == OpcodeGetNonce {
		p.processNonceResponse(chainID, respData)
		return
	}
	
	// Regular response
	resp := &Response{
		Status:   status,
		ChainID:  chainID,
		Register: register,
		Data:     respData,
	}
	
	select {
	case p.responses <- resp:
	default:
		p.logger.Warn("Response channel full")
	}
}

func (p *BitmainProtocol) processNonceResponse(chainID uint8, data []byte) {
	if len(data) < 16 {
		return
	}
	
	buf := bytes.NewReader(data)
	
	var jobID uint32
	var chipID uint8
	var nonce uint32
	var timestamp uint64
	
	binary.Read(buf, binary.LittleEndian, &jobID)
	binary.Read(buf, binary.LittleEndian, &chipID)
	binary.Read(buf, binary.LittleEndian, &nonce)
	binary.Read(buf, binary.LittleEndian, &timestamp)
	
	nonceResp := &NonceResponse{
		JobID:     jobID,
		ChainID:   chainID,
		ChipID:    chipID,
		Nonce:     nonce,
		Timestamp: timestamp,
	}
	
	select {
	case p.nonces <- nonceResp:
	default:
		p.logger.Warn("Nonce channel full")
	}
}

func (p *BitmainProtocol) sendFirmwareChunk(offset int, data []byte) error {
	buf := new(bytes.Buffer)
	binary.Write(buf, binary.LittleEndian, uint32(offset))
	binary.Write(buf, binary.LittleEndian, uint32(len(data)))
	buf.Write(data)
	
	cmd := Command{
		Opcode: OpcodeFirmwareUpd,
		Data:   buf.Bytes(),
	}
	
	resp, err := p.SendCommand(cmd)
	if err != nil {
		return err
	}
	
	if resp.Status != ResponseOK {
		return fmt.Errorf("firmware chunk failed: status=%d", resp.Status)
	}
	
	return nil
}

func (p *BitmainProtocol) calculateChecksum(data []byte) uint16 {
	var sum uint32
	for _, b := range data {
		sum += uint32(b)
	}
	return uint16(sum & 0xFFFF)
}