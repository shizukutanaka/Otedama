package security

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2ptls "github.com/libp2p/go-libp2p/p2p/security/tls"
	"go.uber.org/zap"
)

// EncryptionManager manages all encryption methods
type EncryptionManager struct {
	logger *zap.Logger
	
	// TLS configuration
	tlsConfig    *tls.Config
	tlsCerts     map[string]*tls.Certificate
	tlsMutex     sync.RWMutex
	
	// libp2p host
	p2pHost      host.Host
	p2pPrivKey   crypto.PrivKey
	
	// Noise protocol
	noiseConfig  *NoiseConfig
	
	// Certificate management
	certStore    CertificateStore
	certRotator  *CertificateRotator
	
	// Configuration
	config       EncryptionConfig
	
	// Metrics
	metrics      struct {
		tlsConnections    uint64
		p2pConnections    uint64
		noiseConnections  uint64
		encryptionErrors  uint64
		certRotations     uint64
	}
}

// EncryptionConfig defines encryption configuration
type EncryptionConfig struct {
	// TLS settings
	EnableTLS        bool     `json:"enable_tls"`
	TLSMinVersion    string   `json:"tls_min_version"`
	TLSCipherSuites  []string `json:"tls_cipher_suites"`
	TLSCertFile      string   `json:"tls_cert_file"`
	TLSKeyFile       string   `json:"tls_key_file"`
	TLSCAFile        string   `json:"tls_ca_file"`
	
	// Certificate settings
	AutoGenerateCert bool          `json:"auto_generate_cert"`
	CertRotation     bool          `json:"cert_rotation"`
	CertLifetime     time.Duration `json:"cert_lifetime"`
	
	// libp2p settings
	EnableLibp2p     bool     `json:"enable_libp2p"`
	P2PListenAddrs   []string `json:"p2p_listen_addrs"`
	P2PBootstrapPeers []string `json:"p2p_bootstrap_peers"`
	
	// Noise protocol settings
	EnableNoise      bool     `json:"enable_noise"`
	NoisePattern     string   `json:"noise_pattern"`
	
	// Security settings
	RequireMutualTLS bool     `json:"require_mutual_tls"`
	AllowedCNs       []string `json:"allowed_cns"`
	PinPublicKeys    []string `json:"pin_public_keys"`
}

// NoiseConfig represents Noise protocol configuration
type NoiseConfig struct {
	Pattern        string
	LocalStatic    []byte
	RemoteStatic   []byte
	Prologue       []byte
}

// CertificateStore manages certificates
type CertificateStore interface {
	GetCertificate(name string) (*tls.Certificate, error)
	StoreCertificate(name string, cert *tls.Certificate) error
	ListCertificates() ([]string, error)
	DeleteCertificate(name string) error
}

// NewEncryptionManager creates a new encryption manager
func NewEncryptionManager(logger *zap.Logger, config EncryptionConfig) (*EncryptionManager, error) {
	em := &EncryptionManager{
		logger:    logger,
		config:    config,
		tlsCerts:  make(map[string]*tls.Certificate),
		certStore: NewMemoryCertStore(), // Can be replaced with persistent store
	}
	
	// Initialize TLS if enabled
	if config.EnableTLS {
		if err := em.initializeTLS(); err != nil {
			return nil, fmt.Errorf("failed to initialize TLS: %w", err)
		}
	}
	
	// Initialize libp2p if enabled
	if config.EnableLibp2p {
		if err := em.initializeLibp2p(); err != nil {
			return nil, fmt.Errorf("failed to initialize libp2p: %w", err)
		}
	}
	
	// Initialize Noise if enabled
	if config.EnableNoise {
		if err := em.initializeNoise(); err != nil {
			return nil, fmt.Errorf("failed to initialize Noise: %w", err)
		}
	}
	
	// Start certificate rotation if enabled
	if config.CertRotation {
		em.certRotator = NewCertificateRotator(logger, em.certStore, config.CertLifetime)
		go em.certRotator.Start()
	}
	
	return em, nil
}

// initializeTLS sets up TLS configuration
func (em *EncryptionManager) initializeTLS() error {
	// Parse TLS version
	minVersion := tls.VersionTLS12
	switch em.config.TLSMinVersion {
	case "TLS1.0":
		minVersion = tls.VersionTLS10
	case "TLS1.1":
		minVersion = tls.VersionTLS11
	case "TLS1.2":
		minVersion = tls.VersionTLS12
	case "TLS1.3":
		minVersion = tls.VersionTLS13
	}
	
	// Create TLS config
	em.tlsConfig = &tls.Config{
		MinVersion:               uint16(minVersion),
		PreferServerCipherSuites: true,
		CurvePreferences: []tls.CurveID{
			tls.X25519,
			tls.CurveP256,
		},
		GetCertificate: em.getCertificate,
		ClientAuth:     tls.NoClientCert,
	}
	
	// Set cipher suites if specified
	if len(em.config.TLSCipherSuites) > 0 {
		em.tlsConfig.CipherSuites = parseCipherSuites(em.config.TLSCipherSuites)
	}
	
	// Enable mutual TLS if required
	if em.config.RequireMutualTLS {
		em.tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
		em.tlsConfig.VerifyPeerCertificate = em.verifyPeerCertificate
	}
	
	// Load or generate certificates
	if em.config.AutoGenerateCert {
		cert, err := em.generateSelfSignedCert()
		if err != nil {
			return fmt.Errorf("failed to generate certificate: %w", err)
		}
		em.tlsCerts["default"] = cert
	} else {
		// Load from files
		cert, err := tls.LoadX509KeyPair(em.config.TLSCertFile, em.config.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("failed to load certificate: %w", err)
		}
		em.tlsCerts["default"] = &cert
	}
	
	// Load CA if specified
	if em.config.TLSCAFile != "" {
		caCert, err := loadCAFile(em.config.TLSCAFile)
		if err != nil {
			return fmt.Errorf("failed to load CA: %w", err)
		}
		
		em.tlsConfig.RootCAs = x509.NewCertPool()
		em.tlsConfig.RootCAs.AddCert(caCert)
		em.tlsConfig.ClientCAs = em.tlsConfig.RootCAs
	}
	
	em.logger.Info("TLS initialized",
		zap.String("min_version", em.config.TLSMinVersion),
		zap.Bool("mutual_tls", em.config.RequireMutualTLS),
	)
	
	return nil
}

// initializeLibp2p sets up libp2p host
func (em *EncryptionManager) initializeLibp2p() error {
	// Generate or load private key
	privKey, err := em.getOrCreateP2PKey()
	if err != nil {
		return fmt.Errorf("failed to get P2P key: %w", err)
	}
	em.p2pPrivKey = privKey
	
	// Create libp2p options
	opts := []libp2p.Option{
		libp2p.Identity(privKey),
		libp2p.ListenAddrStrings(em.config.P2PListenAddrs...),
		libp2p.Security(libp2ptls.ID, libp2ptls.New),
		libp2p.Security(noise.ID, noise.New),
		libp2p.DefaultTransports,
		libp2p.ConnectionManager(NewConnectionManager()),
		libp2p.EnableNATService(),
		libp2p.EnableAutoRelay(),
	}
	
	// Create host
	host, err := libp2p.New(opts...)
	if err != nil {
		return fmt.Errorf("failed to create libp2p host: %w", err)
	}
	em.p2pHost = host
	
	// Log host info
	em.logger.Info("libp2p host created",
		zap.String("peer_id", host.ID().Pretty()),
		zap.Any("listen_addrs", host.Addrs()),
	)
	
	// Bootstrap to peers if configured
	if len(em.config.P2PBootstrapPeers) > 0 {
		go em.bootstrapP2P()
	}
	
	return nil
}

// initializeNoise sets up Noise protocol
func (em *EncryptionManager) initializeNoise() error {
	// Generate static key for Noise
	staticKey := make([]byte, 32)
	if _, err := rand.Read(staticKey); err != nil {
		return fmt.Errorf("failed to generate Noise static key: %w", err)
	}
	
	em.noiseConfig = &NoiseConfig{
		Pattern:     em.config.NoisePattern,
		LocalStatic: staticKey,
		Prologue:    []byte("otedama-noise-v1"),
	}
	
	if em.noiseConfig.Pattern == "" {
		em.noiseConfig.Pattern = "Noise_XX_25519_ChaChaPoly_SHA256"
	}
	
	em.logger.Info("Noise protocol initialized",
		zap.String("pattern", em.noiseConfig.Pattern),
	)
	
	return nil
}

// generateSelfSignedCert creates a self-signed certificate
func (em *EncryptionManager) generateSelfSignedCert() (*tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization:  []string{"Otedama"},
			Country:       []string{"JP"},
			Province:      []string{""},
			Locality:      []string{""},
			StreetAddress: []string{""},
			PostalCode:    []string{""},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(em.config.CertLifetime),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	
	// Add SANs
	template.DNSNames = []string{"localhost", "otedama.local"}
	template.IPAddresses = []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	
	// Create certificate
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	
	// Encode certificate
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	
	// Encode private key
	privDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: privDER})
	
	// Create TLS certificate
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	
	return &cert, nil
}

// getCertificate returns certificate for SNI
func (em *EncryptionManager) getCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	em.tlsMutex.RLock()
	defer em.tlsMutex.RUnlock()
	
	// Try to find certificate for SNI
	if cert, ok := em.tlsCerts[hello.ServerName]; ok {
		return cert, nil
	}
	
	// Return default certificate
	if cert, ok := em.tlsCerts["default"]; ok {
		return cert, nil
	}
	
	return nil, fmt.Errorf("no certificate available")
}

// verifyPeerCertificate verifies peer certificate
func (em *EncryptionManager) verifyPeerCertificate(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	if len(rawCerts) == 0 {
		return fmt.Errorf("no peer certificate provided")
	}
	
	cert, err := x509.ParseCertificate(rawCerts[0])
	if err != nil {
		return fmt.Errorf("failed to parse peer certificate: %w", err)
	}
	
	// Check allowed CNs
	if len(em.config.AllowedCNs) > 0 {
		allowed := false
		for _, cn := range em.config.AllowedCNs {
			if cert.Subject.CommonName == cn {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("peer CN not allowed: %s", cert.Subject.CommonName)
		}
	}
	
	// Check public key pinning
	if len(em.config.PinPublicKeys) > 0 {
		pubKeyDER, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
		if err != nil {
			return fmt.Errorf("failed to marshal public key: %w", err)
		}
		
		pubKeyHash := fmt.Sprintf("%x", pubKeyDER)
		pinned := false
		for _, pin := range em.config.PinPublicKeys {
			if pubKeyHash == pin {
				pinned = true
				break
			}
		}
		if !pinned {
			return fmt.Errorf("public key not pinned")
		}
	}
	
	return nil
}

// getOrCreateP2PKey gets or creates libp2p private key
func (em *EncryptionManager) getOrCreateP2PKey() (crypto.PrivKey, error) {
	// Try to load existing key
	// In production, this would load from secure storage
	
	// Generate new key
	priv, _, err := crypto.GenerateKeyPair(crypto.Ed25519, 2048)
	if err != nil {
		return nil, err
	}
	
	return priv, nil
}

// bootstrapP2P connects to bootstrap peers
func (em *EncryptionManager) bootstrapP2P() {
	for _, peerAddr := range em.config.P2PBootstrapPeers {
		addr, err := peer.AddrInfoFromString(peerAddr)
		if err != nil {
			em.logger.Warn("Invalid bootstrap peer address",
				zap.String("addr", peerAddr),
				zap.Error(err),
			)
			continue
		}
		
		if err := em.p2pHost.Connect(context.Background(), *addr); err != nil {
			em.logger.Warn("Failed to connect to bootstrap peer",
				zap.String("peer", addr.ID.Pretty()),
				zap.Error(err),
			)
		} else {
			em.logger.Info("Connected to bootstrap peer",
				zap.String("peer", addr.ID.Pretty()),
			)
		}
	}
}

// WrapTLSConn wraps a connection with TLS
func (em *EncryptionManager) WrapTLSConn(conn net.Conn, isClient bool) (net.Conn, error) {
	if !em.config.EnableTLS {
		return conn, nil
	}
	
	if isClient {
		return tls.Client(conn, em.tlsConfig), nil
	}
	return tls.Server(conn, em.tlsConfig), nil
}

// CreateP2PStream creates encrypted P2P stream
func (em *EncryptionManager) CreateP2PStream(ctx context.Context, peerID peer.ID, protocol protocol.ID) (network.Stream, error) {
	if !em.config.EnableLibp2p {
		return nil, fmt.Errorf("libp2p not enabled")
	}
	
	return em.p2pHost.NewStream(ctx, peerID, protocol)
}

// HandleP2PStream handles incoming P2P stream
func (em *EncryptionManager) HandleP2PStream(protocol protocol.ID, handler network.StreamHandler) {
	if em.config.EnableLibp2p {
		em.p2pHost.SetStreamHandler(protocol, handler)
	}
}

// GetTLSConfig returns TLS configuration
func (em *EncryptionManager) GetTLSConfig() *tls.Config {
	return em.tlsConfig
}

// GetP2PHost returns libp2p host
func (em *EncryptionManager) GetP2PHost() host.Host {
	return em.p2pHost
}

// RotateCertificate rotates a certificate
func (em *EncryptionManager) RotateCertificate(name string) error {
	cert, err := em.generateSelfSignedCert()
	if err != nil {
		return fmt.Errorf("failed to generate new certificate: %w", err)
	}
	
	em.tlsMutex.Lock()
	em.tlsCerts[name] = cert
	em.tlsMutex.Unlock()
	
	em.metrics.certRotations++
	
	em.logger.Info("Certificate rotated",
		zap.String("name", name),
	)
	
	return nil
}

// GetMetrics returns encryption metrics
func (em *EncryptionManager) GetMetrics() map[string]uint64 {
	return map[string]uint64{
		"tls_connections":    em.metrics.tlsConnections,
		"p2p_connections":    em.metrics.p2pConnections,
		"noise_connections":  em.metrics.noiseConnections,
		"encryption_errors":  em.metrics.encryptionErrors,
		"cert_rotations":     em.metrics.certRotations,
	}
}

// Helper functions

func parseCipherSuites(suites []string) []uint16 {
	var result []uint16
	
	cipherMap := map[string]uint16{
		"TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256":   tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		"TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384":   tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		"TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256": tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		"TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384": tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		"TLS_AES_128_GCM_SHA256":                   tls.TLS_AES_128_GCM_SHA256,
		"TLS_AES_256_GCM_SHA384":                   tls.TLS_AES_256_GCM_SHA384,
		"TLS_CHACHA20_POLY1305_SHA256":             tls.TLS_CHACHA20_POLY1305_SHA256,
	}
	
	for _, suite := range suites {
		if id, ok := cipherMap[suite]; ok {
			result = append(result, id)
		}
	}
	
	return result
}

func loadCAFile(filename string) (*x509.Certificate, error) {
	// Implementation would load and parse CA certificate
	return nil, nil
}

// MemoryCertStore is an in-memory certificate store
type MemoryCertStore struct {
	mu    sync.RWMutex
	certs map[string]*tls.Certificate
}

func NewMemoryCertStore() *MemoryCertStore {
	return &MemoryCertStore{
		certs: make(map[string]*tls.Certificate),
	}
}

func (mcs *MemoryCertStore) GetCertificate(name string) (*tls.Certificate, error) {
	mcs.mu.RLock()
	defer mcs.mu.RUnlock()
	
	cert, ok := mcs.certs[name]
	if !ok {
		return nil, fmt.Errorf("certificate not found: %s", name)
	}
	return cert, nil
}

func (mcs *MemoryCertStore) StoreCertificate(name string, cert *tls.Certificate) error {
	mcs.mu.Lock()
	defer mcs.mu.Unlock()
	
	mcs.certs[name] = cert
	return nil
}

func (mcs *MemoryCertStore) ListCertificates() ([]string, error) {
	mcs.mu.RLock()
	defer mcs.mu.RUnlock()
	
	names := make([]string, 0, len(mcs.certs))
	for name := range mcs.certs {
		names = append(names, name)
	}
	return names, nil
}

func (mcs *MemoryCertStore) DeleteCertificate(name string) error {
	mcs.mu.Lock()
	defer mcs.mu.Unlock()
	
	delete(mcs.certs, name)
	return nil
}

// CertificateRotator handles automatic certificate rotation
type CertificateRotator struct {
	logger    *zap.Logger
	store     CertificateStore
	lifetime  time.Duration
}

func NewCertificateRotator(logger *zap.Logger, store CertificateStore, lifetime time.Duration) *CertificateRotator {
	return &CertificateRotator{
		logger:   logger,
		store:    store,
		lifetime: lifetime,
	}
}

func (cr *CertificateRotator) Start() {
	// Implementation would periodically check and rotate certificates
}

// ConnectionManager manages libp2p connections
func NewConnectionManager() *ConnManager {
	return &ConnManager{}
}

type ConnManager struct{}

func (cm *ConnManager) TagPeer(p peer.ID, tag string, val int) {}
func (cm *ConnManager) UntagPeer(p peer.ID, tag string) {}
func (cm *ConnManager) UpsertTag(p peer.ID, tag string, upsert func(int) int) {}
func (cm *ConnManager) GetTagInfo(p peer.ID) *network.TagInfo { return nil }
func (cm *ConnManager) TrimOpenConns(ctx context.Context) {}
func (cm *ConnManager) Notifee() network.Notifiee { return nil }
func (cm *ConnManager) Protect(id peer.ID, tag string) {}
func (cm *ConnManager) Unprotect(id peer.ID, tag string) bool { return false }
func (cm *ConnManager) IsProtected(id peer.ID, tag string) bool { return false }
func (cm *ConnManager) Close() error { return nil }