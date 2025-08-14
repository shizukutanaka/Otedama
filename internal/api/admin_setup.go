package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/api/middleware"
	"os"
	"golang.org/x/crypto/bcrypt"
)

// setupAdminRoutes configures admin dashboard routes
func (s *Server) setupAdminRoutes() {
	// Create admin handlers
	adminHandlers := NewAdminHandlers(s.logger, s.poolManager, s.totp)
	
	// Resolve admin credentials and JWT secret from config/env
	adminUser := s.config.AdminUser
	if adminUser == "" {
		if v := os.Getenv("OTEDAMA_ADMIN_USER"); v != "" {
			adminUser = v
		} else {
			adminUser = "admin"
		}
	}
	adminPassHash := s.config.AdminPassHash
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
	jwtSecret := s.config.JWTSecret
	if jwtSecret == "" {
		jwtSecret = os.Getenv("OTEDAMA_JWT_SECRET")
	}

	// Create auth middleware
	authMiddleware := middleware.NewAuthMiddleware(
		s.logger,
		[]byte(jwtSecret),
		adminUser,
		adminPassHash,
	)
	
	// Admin routes
	admin := s.router.PathPrefix("/admin").Subrouter()
	// Apply generic protections to all admin endpoints (including login)
	admin.Use(mux.MiddlewareFunc(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.limiter != nil && !s.limiter.Allow(r.RemoteAddr) {
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