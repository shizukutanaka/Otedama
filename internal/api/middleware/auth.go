package middleware

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"go.uber.org/zap"
)

// AuthMiddleware handles authentication
type AuthMiddleware struct {
	logger       *zap.Logger
	jwtSecret    []byte
	adminUser    string
	adminPassHash string
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
		return
	}
	
	// Generate JWT token
	token, err := m.generateToken(req.Username, "admin")
	if err != nil {
		m.logger.Error("Failed to generate token", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": token,
		"type":  "Bearer",
	})
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

func (m *AuthMiddleware) validateBasicAuth(user, pass string) bool {
	return m.validateCredentials(user, pass)
}

func (m *AuthMiddleware) validateCredentials(user, pass string) bool {
	if user != m.adminUser {
		return false
	}
	
	// Compare password hash (should use bcrypt in production)
	passHash := hashPassword(pass)
	return subtle.ConstantTimeCompare([]byte(passHash), []byte(m.adminPassHash)) == 1
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