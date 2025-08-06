package api

import (
	"net/http"

	"github.com/shizukutanaka/Otedama/internal/api/middleware"
	"github.com/shizukutanaka/Otedama/internal/pool"
)

// setupAdminRoutes configures admin dashboard routes
func (s *Server) setupAdminRoutes() {
	// Create pool manager reference (would be passed to server in real implementation)
	var poolManager *pool.PoolManager // This should be injected

	// Create admin handlers
	adminHandlers := NewAdminHandlers(s.logger, poolManager)
	
	// Create auth middleware
	authMiddleware := middleware.NewAuthMiddleware(
		s.logger,
		[]byte(s.auth.config.JWTSecret),
		"admin", // Should come from config
		"",      // Should come from config
	)
	
	// Admin routes
	admin := s.router.PathPrefix("/admin").Subrouter()
	
	// Login endpoint (public)
	admin.HandleFunc("/login", authMiddleware.Login).Methods("POST")
	
	// Serve admin login page
	admin.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./web/admin/login.html")
	}).Methods("GET")
	
	// Protected admin routes
	adminProtected := admin.PathPrefix("").Subrouter()
	adminProtected.Use(authMiddleware.RequireAdmin)
	
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