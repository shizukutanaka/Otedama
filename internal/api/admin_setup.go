package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/otedama/otedama/internal/api/middleware"
	"os"
	"golang.org/x/crypto/bcrypt"
	"go.uber.org/zap"
)

// setupAdminRoutes configures admin dashboard routes
func (s *Server) setupAdminRoutes() {
	// Create admin handlers
	adminHandlers := NewAdminHandlers(s.logger, s.poolManager, s.totp, s)

	// Resolve admin credentials and JWT secret from config/env
	adminUser := s.config.Auth.AdminUser
	if adminUser == "" {
		if v := os.Getenv("OTEDAMA_ADMIN_USER"); v != "" {
			adminUser = v
		} else {
			adminUser = "admin"
		}
	}
	adminPassHash := s.config.Auth.AdminPassHash
	if adminPassHash == "" {
		// Prefer explicitly provided bcrypt hash
		if ph := os.Getenv("OTEDAMA_ADMIN_PASS_BCRYPT"); ph != "" {
			adminPassHash = ph
		} else if ph := os.Getenv("OTEDAMA_ADMIN_PASS_HASH"); ph != "" {
			// Backward-compatible: accept any precomputed hash string
			adminPassHash = ph
		} else if pw := os.Getenv("OTEDAMA_ADMIN_PASSWORD"); pw != "" {
			// Hash plaintext password with bcrypt
			if hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost); err == nil {
				adminPassHash = string(hash)
			} else {
				// Fallback to SHA-256 hex for backward compatibility
				sum := sha256.Sum256([]byte(pw))
				adminPassHash = hex.EncodeToString(sum[:])
			}
		}
	}
	jwtSecret := s.config.Auth.JWTSecret
	if jwtSecret == "" {
		jwtSecret = os.Getenv("OTEDAMA_JWT_SECRET")
		if jwtSecret == "" {
			// Fallback to generic JWT_SECRET for compatibility with existing setups
			jwtSecret = os.Getenv("JWT_SECRET")
		}
	}

	// If KeyVault is enabled, store the JWT secret securely.
	// The middleware will fetch it from the vault.
	if s.keyVault != nil {
		if jwtSecret != "" {
			if err := s.keyVault.Set("jwt_secret", []byte(jwtSecret)); err != nil {
				s.logger.Fatal("Failed to store JWT secret in KeyVault", zap.Error(err))
			}
		} else {
			// If no secret is configured, we cannot proceed with auth.
			s.logger.Warn("JWT secret is not configured, but KeyVault is enabled. Admin auth will fail.")
		}
	} else if jwtSecret == "" {
		s.logger.Warn("JWT secret is not configured and KeyVault is disabled. Admin auth will be insecure or fail.")
	}

	// Create auth middleware, passing KeyVault if available.
	authMiddleware := middleware.NewAuthMiddleware(
		s.logger,
		s.keyVault,
		adminUser,
		adminPassHash,
	)

	// Admin routes
	admin := s.router.PathPrefix("/admin").Subrouter()
	// Apply generic protections to all admin endpoints (including login)
	admin.Use(mux.MiddlewareFunc(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.rateLimiter != nil && !s.rateLimiter.Allow(r) {
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}))
	admin.Use(mux.MiddlewareFunc(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("X-XSS-Protection", "1; mode=block")
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			w.Header().Set("Content-Security-Policy", "default-src 'self'")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			next.ServeHTTP(w, r)
		})
	}))

	// Login endpoint (public)
	admin.HandleFunc("/login", authMiddleware.Login).Methods("POST")

	// Serve admin login page
	admin.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./web/admin/login.html")
	}).Methods("GET")

	// Admin-auth only routes (no 2FA) for MFA enrollment/management
	adminAuthOnly := admin.PathPrefix("/mfa").Subrouter()
	adminAuthOnly.Use(mux.MiddlewareFunc(authMiddleware.RequireAdmin))
	adminAuthOnly.HandleFunc("/enroll", adminHandlers.EnrollMFA).Methods("POST")
	adminAuthOnly.HandleFunc("/info", adminHandlers.GetMFAInfo).Methods("GET")
	adminAuthOnly.HandleFunc("/disable", adminHandlers.DisableMFA).Methods("POST")
	adminAuthOnly.HandleFunc("/regenerate", adminHandlers.RegenerateBackupCodes).Methods("POST")

	// Protected admin routes
	adminProtected := admin.PathPrefix("").Subrouter()
	// Require admin auth + 2FA (TOTP)
	adminProtected.Use(mux.MiddlewareFunc(authMiddleware.RequireAdminWith2FA(s.totp)))

	// Register admin routes
	adminHandlers.RegisterRoutes(adminProtected)

	// Serve admin dashboard
	adminProtected.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./web/admin/index.html")
	}).Methods("GET")

	// Static files for admin dashboard
	admin.PathPrefix("/static/").Handler(
		http.StripPrefix("/admin/static/", http.FileServer(http.Dir("./web/static/"))),
	)

	s.logger.Info("Admin dashboard routes configured")
}