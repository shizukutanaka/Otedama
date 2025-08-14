package middleware

import (
	"context"
	"fmt"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/prometheus/client_golang/prometheus"
	internalauth "github.com/shizukutanaka/Otedama/internal/auth"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"
)

// AuthMiddleware handles authentication
type AuthMiddleware struct {
	logger       *zap.Logger
	jwtSecret    []byte
	adminUser    string
	adminPassHash string
}

// Metrics
var (
	loginAttempts = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "otedama_auth_login_attempts_total",
			Help: "Total number of admin login attempts",
		},
		[]string{"result"}, // success|failure
	)
	totpVerifications = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "otedama_auth_totp_verifications_total",
			Help: "Total number of admin TOTP verifications",
		},
		[]string{"result"}, // success|invalid|missing|not_enrolled|unavailable|unauthorized
	)
)

func init() {
	// Safe to register multiple times across hot reloads? prometheus panics on duplicate; assume single init per process.
	prometheus.MustRegister(loginAttempts)
	prometheus.MustRegister(totpVerifications)
}

// NewAuthMiddleware creates new auth middleware
func NewAuthMiddleware(logger *zap.Logger, jwtSecret []byte, adminUser, adminPassHash string) *AuthMiddleware {
	return &AuthMiddleware{
		logger:        logger,
		jwtSecret:     jwtSecret,
		adminUser:     adminUser,
		adminPassHash: adminPassHash,
	}
}

// RequireAdmin requires admin authentication
func (m *AuthMiddleware) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check for JWT token
		token := m.extractToken(r)
		if token != "" {
			claims, valid := m.validateToken(token)
			if valid && claims.Role == "admin" {
				ctx := context.WithValue(r.Context(), "user", claims.Username)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		
		// Check for basic auth
		user, pass, ok := r.BasicAuth()
		if ok && m.validateBasicAuth(user, pass) {
			ctx := context.WithValue(r.Context(), "user", user)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		
		// Request authentication
		w.Header().Set("WWW-Authenticate", `Basic realm="Admin"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	})
}

// RequireAdminWith2FA requires admin authentication and validates a TOTP code.
// The TOTP code is expected in the "X-TOTP-Code" header (fallbacks: "X-OTP-Code", query param "mfa").
func (m *AuthMiddleware) RequireAdminWith2FA(totp *internalauth.TOTPProvider) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// First, perform admin auth (JWT or Basic) like RequireAdmin
			var userID string

			// Check for JWT token
			token := m.extractToken(r)
			if token != "" {
				if claims, valid := m.validateToken(token); valid && claims.Role == "admin" {
					userID = claims.Username
				}
			}

			// Fallback to Basic Auth
			if userID == "" {
				if user, pass, ok := r.BasicAuth(); ok && m.validateBasicAuth(user, pass) {
					userID = user
				}
			}

			if userID == "" {
				w.Header().Set("WWW-Authenticate", `Basic realm="Admin"`)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				totpVerifications.WithLabelValues("unauthorized").Inc()
				return
			}

			// Enforce TOTP 2FA
			if totp == nil {
				http.Error(w, "2FA provider unavailable", http.StatusUnauthorized)
				totpVerifications.WithLabelValues("unavailable").Inc()
				return
			}

			// If user is enrolled, require a valid code; if not enrolled, deny by default for safety
			if !totp.IsEnrolled(userID) {
				http.Error(w, "2FA not enrolled", http.StatusUnauthorized)
				totpVerifications.WithLabelValues("not_enrolled").Inc()
				return
			}

			code := r.Header.Get("X-TOTP-Code")
			if code == "" {
				code = r.Header.Get("X-OTP-Code")
			}
			if code == "" {
				code = r.URL.Query().Get("mfa")
			}

			if code == "" {
				http.Error(w, "Missing 2FA code", http.StatusUnauthorized)
				totpVerifications.WithLabelValues("missing").Inc()
				return
			}

			// Verify code (challenge not used by TOTP provider)
			if ok, _ := totp.VerifyResponse(userID, "", code); !ok {
				http.Error(w, "Invalid 2FA code", http.StatusUnauthorized)
				totpVerifications.WithLabelValues("invalid").Inc()
				return
			}

			// Success: attach user context and proceed
			totpVerifications.WithLabelValues("success").Inc()
			ctx := context.WithValue(r.Context(), "user", userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Login handles admin login
func (m *AuthMiddleware) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	
	if !m.validateCredentials(req.Username, req.Password) {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		loginAttempts.WithLabelValues("failure").Inc()
		return
	}
	
	// Generate JWT token
	token, err := m.generateToken(req.Username, "admin")
	if err != nil {
		m.logger.Error("Failed to generate token", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		loginAttempts.WithLabelValues("failure").Inc()
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": token,
		"type":  "Bearer",
	})
	loginAttempts.WithLabelValues("success").Inc()
}

// Claims represents JWT claims
type Claims struct {
	Username string `json:"username"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

func (m *AuthMiddleware) extractToken(r *http.Request) string {
	// Check Authorization header
	auth := r.Header.Get("Authorization")
	if auth != "" {
		parts := strings.Split(auth, " ")
		if len(parts) == 2 && parts[0] == "Bearer" {
			return parts[1]
		}
	}
	
	// Check cookie
	cookie, err := r.Cookie("auth_token")
	if err == nil {
		return cookie.Value
	}
	
	// Check query parameter
	return r.URL.Query().Get("token")
}

func (m *AuthMiddleware) validateToken(tokenString string) (*Claims, bool) {
	claims := &Claims{}
	
	token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (interface{}, error) {
		return m.jwtSecret, nil
	})
	
	if err != nil || !token.Valid {
		return nil, false
	}
	
	return claims, true
}

// ValidateToken exposes token validation for other components (e.g., SecurityMiddleware)
func (m *AuthMiddleware) ValidateToken(tokenString string) (interface{}, error) {
	if claims, ok := m.validateToken(tokenString); ok {
		return claims, nil
	}
	return nil, fmt.Errorf("invalid token")
}

func (m *AuthMiddleware) validateBasicAuth(user, pass string) bool {
	return m.validateCredentials(user, pass)
}

func (m *AuthMiddleware) validateCredentials(user, pass string) bool {
	if user != m.adminUser {
		return false
	}
	// Detect hash format and verify accordingly
	hash := m.adminPassHash
	if isBcryptHash(hash) {
		// bcrypt stored hash
		return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pass)) == nil
	}
	if isHexSHA256(hash) {
		// Legacy SHA-256 hex hash comparison
		passHash := hashPassword(pass)
		return subtle.ConstantTimeCompare([]byte(passHash), []byte(hash)) == 1
	}
	// Fallback: treat config as plaintext (not recommended)
	return subtle.ConstantTimeCompare([]byte(pass), []byte(hash)) == 1
}

func (m *AuthMiddleware) generateToken(username, role string) (string, error) {
	claims := &Claims{
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}
	
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(m.jwtSecret)
}

// Simple password hashing for demo (use bcrypt in production)
func hashPassword(password string) string {
	h := sha256.New()
	h.Write([]byte(password))
	return hex.EncodeToString(h.Sum(nil))
}

// Helpers to detect hash type
func isBcryptHash(s string) bool {
	return strings.HasPrefix(s, "$2a$") || strings.HasPrefix(s, "$2b$") || strings.HasPrefix(s, "$2y$")
}

func isHexSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}