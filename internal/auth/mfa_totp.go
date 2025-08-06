package auth

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"fmt"
	"sync"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"go.uber.org/zap"
)

// TOTPProvider implements TOTP-based MFA
type TOTPProvider struct {
	logger *zap.Logger
	
	// User secrets storage (in production, use secure storage)
	secrets map[string]*TOTPSecret
	mu      sync.RWMutex
	
	// Configuration
	config  TOTPConfig
}

// TOTPConfig defines TOTP configuration
type TOTPConfig struct {
	Issuer       string `json:"issuer"`
	AccountName  string `json:"account_name"`
	Period       uint   `json:"period"`        // Time step in seconds (default 30)
	Digits       int    `json:"digits"`        // Code length (default 6)
	Skew         uint   `json:"skew"`          // Time skew allowance (default 1)
	SecretLength int    `json:"secret_length"` // Secret key length (default 32)
}

// TOTPSecret stores user TOTP secret
type TOTPSecret struct {
	UserID      string    `json:"user_id"`
	Secret      string    `json:"secret"`
	BackupCodes []string  `json:"backup_codes"`
	CreatedAt   time.Time `json:"created_at"`
	LastUsed    time.Time `json:"last_used"`
	UseCount    int       `json:"use_count"`
}

// NewTOTPProvider creates a new TOTP provider
func NewTOTPProvider(logger *zap.Logger, config TOTPConfig) *TOTPProvider {
	// Set defaults
	if config.Period == 0 {
		config.Period = 30
	}
	if config.Digits == 0 {
		config.Digits = 6
	}
	if config.Skew == 0 {
		config.Skew = 1
	}
	if config.SecretLength == 0 {
		config.SecretLength = 32
	}
	if config.Issuer == "" {
		config.Issuer = "Otedama"
	}
	
	return &TOTPProvider{
		logger:  logger,
		secrets: make(map[string]*TOTPSecret),
		config:  config,
	}
}

// EnrollUser enrolls a user for TOTP
func (tp *TOTPProvider) EnrollUser(userID string, data interface{}) error {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	// Check if already enrolled
	if _, exists := tp.secrets[userID]; exists {
		return fmt.Errorf("user %s already enrolled for TOTP", userID)
	}
	
	// Generate secret
	secret := make([]byte, tp.config.SecretLength)
	if _, err := rand.Read(secret); err != nil {
		return fmt.Errorf("failed to generate secret: %w", err)
	}
	
	// Encode secret
	encodedSecret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
	
	// Generate backup codes
	backupCodes := tp.generateBackupCodes(8)
	
	// Store secret
	tp.secrets[userID] = &TOTPSecret{
		UserID:      userID,
		Secret:      encodedSecret,
		BackupCodes: backupCodes,
		CreatedAt:   time.Now(),
	}
	
	tp.logger.Info("User enrolled for TOTP",
		zap.String("user_id", userID),
	)
	
	return nil
}

// GenerateChallenge generates a TOTP challenge (returns QR code URL)
func (tp *TOTPProvider) GenerateChallenge(userID string) (string, error) {
	tp.mu.RLock()
	secret, exists := tp.secrets[userID]
	tp.mu.RUnlock()
	
	if !exists {
		return "", fmt.Errorf("user %s not enrolled for TOTP", userID)
	}
	
	// Generate provisioning URI for QR code
	key, err := otp.NewKeyFromURL(fmt.Sprintf(
		"otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		tp.config.Issuer,
		userID,
		secret.Secret,
		tp.config.Issuer,
		tp.config.Digits,
		tp.config.Period,
	))
	
	if err != nil {
		return "", fmt.Errorf("failed to create OTP key: %w", err)
	}
	
	return key.URL(), nil
}

// VerifyResponse verifies a TOTP code
func (tp *TOTPProvider) VerifyResponse(userID, challenge, response string) (bool, error) {
	tp.mu.RLock()
	secret, exists := tp.secrets[userID]
	tp.mu.RUnlock()
	
	if !exists {
		return false, fmt.Errorf("user %s not enrolled for TOTP", userID)
	}
	
	// Check if it's a backup code
	if tp.verifyBackupCode(userID, response) {
		return true, nil
	}
	
	// Verify TOTP code
	valid := totp.Validate(response, secret.Secret)
	
	if valid {
		// Update usage stats
		tp.mu.Lock()
		secret.LastUsed = time.Now()
		secret.UseCount++
		tp.mu.Unlock()
		
		tp.logger.Info("TOTP verification successful",
			zap.String("user_id", userID),
		)
	}
	
	return valid, nil
}

// IsEnrolled checks if a user is enrolled for TOTP
func (tp *TOTPProvider) IsEnrolled(userID string) bool {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	
	_, exists := tp.secrets[userID]
	return exists
}

// GetEnrollmentInfo returns enrollment information
func (tp *TOTPProvider) GetEnrollmentInfo(userID string) (*EnrollmentInfo, error) {
	tp.mu.RLock()
	secret, exists := tp.secrets[userID]
	tp.mu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("user %s not enrolled for TOTP", userID)
	}
	
	// Generate QR code URL
	qrURL, err := tp.GenerateChallenge(userID)
	if err != nil {
		return nil, err
	}
	
	return &EnrollmentInfo{
		UserID:          userID,
		Method:          "TOTP",
		Secret:          secret.Secret,
		QRCode:          qrURL,
		BackupCodes:     secret.BackupCodes,
		EnrollmentDate:  secret.CreatedAt,
		LastUsed:        secret.LastUsed,
		UseCount:        secret.UseCount,
	}, nil
}

// DisableUser disables TOTP for a user
func (tp *TOTPProvider) DisableUser(userID string) error {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	if _, exists := tp.secrets[userID]; !exists {
		return fmt.Errorf("user %s not enrolled for TOTP", userID)
	}
	
	delete(tp.secrets, userID)
	
	tp.logger.Info("TOTP disabled for user",
		zap.String("user_id", userID),
	)
	
	return nil
}

// RegenerateBackupCodes regenerates backup codes for a user
func (tp *TOTPProvider) RegenerateBackupCodes(userID string) ([]string, error) {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	secret, exists := tp.secrets[userID]
	if !exists {
		return nil, fmt.Errorf("user %s not enrolled for TOTP", userID)
	}
	
	// Generate new backup codes
	backupCodes := tp.generateBackupCodes(8)
	secret.BackupCodes = backupCodes
	
	tp.logger.Info("Backup codes regenerated",
		zap.String("user_id", userID),
		zap.Int("count", len(backupCodes)),
	)
	
	return backupCodes, nil
}

// Helper methods

// generateBackupCodes generates backup codes
func (tp *TOTPProvider) generateBackupCodes(count int) []string {
	codes := make([]string, count)
	
	for i := 0; i < count; i++ {
		b := make([]byte, 6)
		rand.Read(b)
		codes[i] = base64.URLEncoding.EncodeToString(b)[:8]
	}
	
	return codes
}

// verifyBackupCode verifies and consumes a backup code
func (tp *TOTPProvider) verifyBackupCode(userID, code string) bool {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	secret, exists := tp.secrets[userID]
	if !exists {
		return false
	}
	
	// Check backup codes
	for i, backupCode := range secret.BackupCodes {
		if backupCode == code {
			// Remove used backup code
			secret.BackupCodes = append(secret.BackupCodes[:i], secret.BackupCodes[i+1:]...)
			secret.LastUsed = time.Now()
			secret.UseCount++
			
			tp.logger.Info("Backup code used",
				zap.String("user_id", userID),
				zap.Int("remaining", len(secret.BackupCodes)),
			)
			
			return true
		}
	}
	
	return false
}

// EnrollmentInfo contains TOTP enrollment information
type EnrollmentInfo struct {
	UserID         string    `json:"user_id"`
	Method         string    `json:"method"`
	Secret         string    `json:"secret"`
	QRCode         string    `json:"qr_code"`
	BackupCodes    []string  `json:"backup_codes"`
	EnrollmentDate time.Time `json:"enrollment_date"`
	LastUsed       time.Time `json:"last_used"`
	UseCount       int       `json:"use_count"`
}

// WebAuthnProvider implements WebAuthn-based MFA
type WebAuthnProvider struct {
	logger *zap.Logger
	
	// User credentials storage
	credentials map[string][]*WebAuthnCredential
	mu          sync.RWMutex
	
	// Configuration
	config      WebAuthnConfig
}

// WebAuthnConfig defines WebAuthn configuration
type WebAuthnConfig struct {
	RPName        string   `json:"rp_name"`
	RPID          string   `json:"rp_id"`
	RPOrigins     []string `json:"rp_origins"`
	AttestationPreference string `json:"attestation_preference"`
	UserVerification     string `json:"user_verification"`
	Timeout              int    `json:"timeout"`
}

// WebAuthnCredential represents a WebAuthn credential
type WebAuthnCredential struct {
	ID              string    `json:"id"`
	UserID          string    `json:"user_id"`
	PublicKey       []byte    `json:"public_key"`
	Counter         uint32    `json:"counter"`
	CredentialType  string    `json:"credential_type"`
	Transports      []string  `json:"transports"`
	AAGUID          []byte    `json:"aaguid"`
	CreatedAt       time.Time `json:"created_at"`
	LastUsed        time.Time `json:"last_used"`
	Name            string    `json:"name"`
}

// EmailMFAProvider implements email-based MFA
type EmailMFAProvider struct {
	logger *zap.Logger
	
	// Pending codes
	codes  map[string]*EmailCode
	mu     sync.RWMutex
	
	// Email sender
	sender EmailSender
	
	// Configuration
	config EmailMFAConfig
}

// EmailMFAConfig defines email MFA configuration
type EmailMFAConfig struct {
	CodeLength    int           `json:"code_length"`
	CodeExpiry    time.Duration `json:"code_expiry"`
	MaxAttempts   int           `json:"max_attempts"`
	TemplatePath  string        `json:"template_path"`
}

// EmailCode represents an email verification code
type EmailCode struct {
	UserID    string    `json:"user_id"`
	Code      string    `json:"code"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Attempts  int       `json:"attempts"`
	Verified  bool      `json:"verified"`
}

// EmailSender interface for sending emails
type EmailSender interface {
	SendMFACode(email, code string) error
}

// SMSMFAProvider implements SMS-based MFA
type SMSMFAProvider struct {
	logger *zap.Logger
	
	// Pending codes
	codes  map[string]*SMSCode
	mu     sync.RWMutex
	
	// SMS sender
	sender SMSSender
	
	// Configuration
	config SMSMFAConfig
}

// SMSMFAConfig defines SMS MFA configuration
type SMSMFAConfig struct {
	CodeLength    int           `json:"code_length"`
	CodeExpiry    time.Duration `json:"code_expiry"`
	MaxAttempts   int           `json:"max_attempts"`
	MessageFormat string        `json:"message_format"`
}

// SMSCode represents an SMS verification code
type SMSCode struct {
	UserID      string    `json:"user_id"`
	Code        string    `json:"code"`
	PhoneNumber string    `json:"phone_number"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	Attempts    int       `json:"attempts"`
	Verified    bool      `json:"verified"`
}

// SMSSender interface for sending SMS messages
type SMSSender interface {
	SendSMS(phoneNumber, message string) error
}