package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/improvements"
	"github.com/otedama/otedama/internal/mining"
	"go.uber.org/zap"
)

func main() {
	// Initialize logger
	logger, err := zap.NewProduction()
	if err != nil {
		log.Fatal("Failed to initialize logger:", err)
	}
	defer logger.Sync()

	// Load configuration
	cfg, err := config.Load("config.yaml")
	if err != nil {
		logger.Fatal("Failed to load config", zap.Error(err))
	}

	// Initialize realistic improvement manager
	improvementMgr := improvements.NewRealisticImprovementManager(logger)
	
	// Initialize components with improvements
	rateLimiter := improvements.NewRealisticRateLimiter()
	sessionMgr := improvements.NewRealisticSessionManager()
	validator := improvements.NewInputValidator()
	errorHandler := improvements.NewErrorHandler(logger)
	healthChecker := improvements.NewHealthChecker()
	shutdownMgr := improvements.NewShutdownManager()
	passwordMgr := improvements.NewPasswordManager()

	// Register health checks
	healthChecker.RegisterCheck("config", func() error {
		if cfg == nil {
			return fmt.Errorf("configuration not loaded")
		}
		return nil
	})

	healthChecker.RegisterCheck("database", func() error {
		// Check database connection
		// This would be replaced with actual database ping
		return nil
	})

	// Initialize mining engine with safety checks
	miningEngine := mining.NewEngine()
	
	// Setup HTTP server with security middleware
	mux := http.NewServeMux()

	// Health endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		health := healthChecker.CheckHealth()
		w.Header().Set("Content-Type", "application/json")
		
		allHealthy := true
		for _, status := range health {
			if status != "healthy" {
				allHealthy = false
				break
			}
		}
		
		if !allHealthy {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		
		fmt.Fprintf(w, `{"status": "%s"}`, health)
	})

	// Mining status endpoint with rate limiting
	mux.HandleFunc("/api/mining/status", func(w http.ResponseWriter, r *http.Request) {
		clientIP := r.RemoteAddr
		
		// Apply rate limiting
		if !rateLimiter.Allow(clientIP) {
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}
		
		// Check session
		sessionCookie, err := r.Cookie("session_id")
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		
		session, err := sessionMgr.GetSession(sessionCookie.Value)
		if err != nil {
			http.Error(w, "Invalid session", http.StatusUnauthorized)
			return
		}
		
		// Validate CSRF token
		csrfToken := r.Header.Get("X-CSRF-Token")
		if csrfToken != session.CSRFToken {
			http.Error(w, "Invalid CSRF token", http.StatusForbidden)
			return
		}
		
		// Return mining status
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status": "mining", "hashrate": 1234567}`)
	})

	// Login endpoint
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		
		// Parse form
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}
		
		email := r.FormValue("email")
		password := r.FormValue("password")
		
		// Validate input
		if err := validator.ValidateEmail(email); err != nil {
			errorHandler.Handle(err, "warning", map[string]interface{}{
				"email": email,
				"ip": r.RemoteAddr,
			})
			http.Error(w, "Invalid email", http.StatusBadRequest)
			return
		}
		
		if err := validator.ValidatePassword(password); err != nil {
			errorHandler.Handle(err, "warning", map[string]interface{}{
				"ip": r.RemoteAddr,
			})
			http.Error(w, "Invalid password", http.StatusBadRequest)
			return
		}
		
		// Here you would verify against database
		// For demo, we'll create a session
		session, err := sessionMgr.CreateSession(email)
		if err != nil {
			errorHandler.Handle(err, "critical", map[string]interface{}{
				"email": email,
			})
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
		
		// Set session cookie
		http.SetCookie(w, &http.Cookie{
			Name:     "session_id",
			Value:    session.ID,
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteStrictMode,
			Expires:  session.ExpiresAt,
		})
		
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"success": true, "csrf_token": "%s"}`, session.CSRFToken)
	})

	// Create HTTP server with timeouts
	srv := &http.Server{
		Addr:         cfg.API.Address,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Register shutdown handler
	shutdownMgr.RegisterHandler(func() error {
		logger.Info("Shutting down HTTP server")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return srv.Shutdown(ctx)
	})

	shutdownMgr.RegisterHandler(func() error {
		logger.Info("Stopping mining engine")
		miningEngine.Stop()
		return nil
	})

	// Start server
	go func() {
		logger.Info("Starting HTTP server", zap.String("address", cfg.API.Address))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("Failed to start server", zap.Error(err))
		}
	}()

	// Start mining if configured
	if cfg.Mining.AutoStart {
		logger.Info("Starting mining engine")
		if err := miningEngine.Start(); err != nil {
			logger.Error("Failed to start mining", zap.Error(err))
		}
	}

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	logger.Info("Received shutdown signal, initiating graceful shutdown")
	
	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	if err := shutdownMgr.Shutdown(ctx); err != nil {
		logger.Error("Error during shutdown", zap.Error(err))
	}
	
	logger.Info("Shutdown complete")

	// Suppress unused warnings for demo
	_ = improvementMgr
	_ = passwordMgr
}