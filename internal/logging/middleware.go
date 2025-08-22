package logging

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"
)

// HTTPMiddleware provides HTTP request logging middleware
type HTTPMiddleware struct {
	logger     *Logger
	skipPaths  map[string]bool
	skipIPs    map[string]bool
	logBodies  bool
	maxBodyLen int
}

// NewHTTPMiddleware creates new HTTP logging middleware
func NewHTTPMiddleware(logger *Logger) *HTTPMiddleware {
	return &HTTPMiddleware{
		logger:     logger,
		skipPaths:  make(map[string]bool),
		skipIPs:    make(map[string]bool),
		logBodies:  false,
		maxBodyLen: 1024, // 1KB default
	}
}

// WithSkipPaths sets paths to skip logging
func (m *HTTPMiddleware) WithSkipPaths(paths ...string) *HTTPMiddleware {
	for _, path := range paths {
		m.skipPaths[path] = true
	}
	return m
}

// WithSkipIPs sets IP addresses to skip logging
func (m *HTTPMiddleware) WithSkipIPs(ips ...string) *HTTPMiddleware {
	for _, ip := range ips {
		m.skipIPs[ip] = true
	}
	return m
}

// WithBodyLogging enables/disables request/response body logging
func (m *HTTPMiddleware) WithBodyLogging(enabled bool, maxLen int) *HTTPMiddleware {
	m.logBodies = enabled
	m.maxBodyLen = maxLen
	return m
}

// responseWriter wraps http.ResponseWriter to capture response data
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	body       *bytes.Buffer
	size       int64
}

// newResponseWriter creates a new response writer wrapper
func newResponseWriter(w http.ResponseWriter, captureBody bool) *responseWriter {
	rw := &responseWriter{
		ResponseWriter: w,
		statusCode:     http.StatusOK,
		size:          0,
	}
	if captureBody {
		rw.body = &bytes.Buffer{}
	}
	return rw
}

// WriteHeader captures the status code
func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Write captures the response data
func (rw *responseWriter) Write(data []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(data)
	rw.size += int64(n)
	
	if rw.body != nil && rw.body.Len() < 1024 { // Limit captured body size
		rw.body.Write(data[:min(len(data), 1024-rw.body.Len())])
	}
	
	return n, err
}

// min returns the minimum of two integers
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Middleware returns the HTTP middleware function
func (m *HTTPMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Skip logging for certain paths or IPs
		if m.skipPaths[r.URL.Path] || m.skipIPs[getClientIP(r)] {
			next.ServeHTTP(w, r)
			return
		}
		
		// Generate request ID
		requestID := generateRequestID()
		
		// Add request ID to context
		ctx := context.WithValue(r.Context(), "request_id", requestID)
		r = r.WithContext(ctx)
		
		// Capture request body if enabled
		var requestBody string
		if m.logBodies && r.Body != nil {
			bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, int64(m.maxBodyLen)))
			if err == nil {
				requestBody = string(bodyBytes)
				r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
			}
		}
		
		// Wrap response writer
		wrapped := newResponseWriter(w, m.logBodies)
		
		// Add response headers for tracking
		wrapped.Header().Set("X-Request-ID", requestID)
		
		// Execute request
		next.ServeHTTP(wrapped, r)
		
		// Calculate duration
		duration := time.Since(start)
		
		// Build log fields
		fields := []zap.Field{
			zap.String("request_id", requestID),
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("query", r.URL.RawQuery),
			zap.String("client_ip", getClientIP(r)),
			zap.String("user_agent", r.UserAgent()),
			zap.String("referer", r.Referer()),
			zap.Int("status_code", wrapped.statusCode),
			zap.Int64("response_size", wrapped.size),
			zap.Duration("duration", duration),
			zap.String("protocol", r.Proto),
		}
		
		// Add request headers
		if len(r.Header) > 0 {
			headers := make(map[string]string)
			for key, values := range r.Header {
				if !isSensitiveHeader(key) {
					headers[key] = strings.Join(values, ", ")
				}
			}
			fields = append(fields, zap.Any("request_headers", headers))
		}
		
		// Add request body if captured
		if requestBody != "" {
			fields = append(fields, zap.String("request_body", requestBody))
		}
		
		// Add response body if captured
		if wrapped.body != nil && wrapped.body.Len() > 0 {
			fields = append(fields, zap.String("response_body", wrapped.body.String()))
		}
		
		// Determine log level based on status code
		logLevel := m.getLogLevel(wrapped.statusCode)
		
		// Log the request
		switch logLevel {
		case LevelError:
			m.logger.ErrorCtx(ctx, "HTTP request completed with error", fields...)
		case LevelWarn:
			m.logger.WarnCtx(ctx, "HTTP request completed with warning", fields...)
		default:
			m.logger.InfoCtx(ctx, "HTTP request completed", fields...)
		}
	})
}

// getClientIP extracts the real client IP from request
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP in the chain
		if ips := strings.Split(xff, ","); len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}
	
	// Check X-Real-IP header
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	
	// Fall back to RemoteAddr
	if ip := strings.Split(r.RemoteAddr, ":"); len(ip) > 0 {
		return ip[0]
	}
	
	return r.RemoteAddr
}

// getLogLevel determines log level based on HTTP status code
func (m *HTTPMiddleware) getLogLevel(statusCode int) LogLevel {
	switch {
	case statusCode >= 500:
		return LevelError
	case statusCode >= 400:
		return LevelWarn
	default:
		return LevelInfo
	}
}

// isSensitiveHeader checks if header contains sensitive information
func isSensitiveHeader(header string) bool {
	sensitiveHeaders := []string{
		"authorization",
		"cookie",
		"x-auth-token",
		"x-api-key",
		"authorization",
		"proxy-authorization",
	}
	
	headerLower := strings.ToLower(header)
	for _, sensitive := range sensitiveHeaders {
		if headerLower == sensitive {
			return true
		}
	}
	
	return false
}

// generateRequestID generates a unique request ID
func generateRequestID() string {
	// Simple implementation - in production might use UUID
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

// AccessLogger provides access log functionality
type AccessLogger struct {
	logger *Logger
	format string
}

// NewAccessLogger creates a new access logger
func NewAccessLogger(logger *Logger, format string) *AccessLogger {
	if format == "" {
		format = "combined" // Apache combined log format
	}
	
	return &AccessLogger{
		logger: logger,
		format: format,
	}
}

// Log logs an HTTP request in access log format
func (al *AccessLogger) Log(r *http.Request, statusCode int, responseSize int64, duration time.Duration) {
	clientIP := getClientIP(r)
	timestamp := time.Now().Format("02/Jan/2006:15:04:05 -0700")
	
	// Format based on specified format
	var logLine string
	switch al.format {
	case "combined":
		logLine = fmt.Sprintf("%s - - [%s] \"%s %s %s\" %d %d \"%s\" \"%s\"",
			clientIP,
			timestamp,
			r.Method,
			r.URL.Path,
			r.Proto,
			statusCode,
			responseSize,
			r.Referer(),
			r.UserAgent(),
		)
	case "common":
		logLine = fmt.Sprintf("%s - - [%s] \"%s %s %s\" %d %d",
			clientIP,
			timestamp,
			r.Method,
			r.URL.Path,
			r.Proto,
			statusCode,
			responseSize,
		)
	default:
		// Custom structured format
		al.logger.Info("HTTP access log",
			zap.String("client_ip", clientIP),
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("protocol", r.Proto),
			zap.Int("status_code", statusCode),
			zap.Int64("response_size", responseSize),
			zap.Duration("duration", duration),
			zap.String("referer", r.Referer()),
			zap.String("user_agent", r.UserAgent()),
		)
		return
	}
	
	al.logger.Info(logLine)
}

// AuditLogger provides audit logging functionality
type AuditLogger struct {
	logger *Logger
}

// NewAuditLogger creates a new audit logger
func NewAuditLogger(logger *Logger) *AuditLogger {
	return &AuditLogger{logger: logger.WithComponent("audit")}
}

// LogEvent logs an audit event
func (al *AuditLogger) LogEvent(event string, userID string, resource string, action string, result string, metadata map[string]interface{}) {
	fields := []zap.Field{
		zap.String("event", event),
		zap.String("user_id", userID),
		zap.String("resource", resource),
		zap.String("action", action),
		zap.String("result", result),
		zap.Time("timestamp", time.Now()),
	}
	
	if metadata != nil {
		fields = append(fields, zap.Any("metadata", metadata))
	}
	
	al.logger.Info("Audit event", fields...)
}

// LogAuthentication logs authentication events
func (al *AuditLogger) LogAuthentication(userID string, clientIP string, success bool, reason string) {
	result := "success"
	if !success {
		result = "failure"
	}
	
	metadata := map[string]interface{}{
		"client_ip": clientIP,
		"reason":    reason,
	}
	
	al.LogEvent("authentication", userID, "system", "login", result, metadata)
}

// LogAuthorization logs authorization events
func (al *AuditLogger) LogAuthorization(userID string, resource string, permission string, granted bool) {
	result := "granted"
	if !granted {
		result = "denied"
	}
	
	metadata := map[string]interface{}{
		"permission": permission,
	}
	
	al.LogEvent("authorization", userID, resource, "access", result, metadata)
}

// LogDataAccess logs data access events
func (al *AuditLogger) LogDataAccess(userID string, resource string, action string, recordCount int) {
	metadata := map[string]interface{}{
		"record_count": recordCount,
	}
	
	al.LogEvent("data_access", userID, resource, action, "success", metadata)
}

// LogConfigurationChange logs configuration changes
func (al *AuditLogger) LogConfigurationChange(userID string, setting string, oldValue interface{}, newValue interface{}) {
	metadata := map[string]interface{}{
		"setting":   setting,
		"old_value": oldValue,
		"new_value": newValue,
	}
	
	al.LogEvent("configuration_change", userID, "system", "update", "success", metadata)
}

// PerformanceLogger provides performance logging
type PerformanceLogger struct {
	logger    *Logger
	threshold time.Duration
}

// NewPerformanceLogger creates a new performance logger
func NewPerformanceLogger(logger *Logger, threshold time.Duration) *PerformanceLogger {
	return &PerformanceLogger{
		logger:    logger.WithComponent("performance"),
		threshold: threshold,
	}
}

// LogOperation logs operation performance
func (pl *PerformanceLogger) LogOperation(operation string, duration time.Duration, success bool, metadata map[string]interface{}) {
	fields := []zap.Field{
		zap.String("operation", operation),
		zap.Duration("duration", duration),
		zap.Bool("success", success),
	}
	
	if metadata != nil {
		fields = append(fields, zap.Any("metadata", metadata))
	}
	
	// Log at different levels based on duration and success
	if !success {
		pl.logger.Error("Operation failed", fields...)
	} else if duration > pl.threshold {
		pl.logger.Warn("Slow operation", fields...)
	} else {
		pl.logger.Debug("Operation completed", fields...)
	}
}

// TraceFunction traces function execution time
func (pl *PerformanceLogger) TraceFunction(name string) func() {
	start := time.Now()
	return func() {
		duration := time.Since(start)
		pl.LogOperation(name, duration, true, nil)
	}
}