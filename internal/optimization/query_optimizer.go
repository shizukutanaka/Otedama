package optimization

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"
	"go.uber.org/zap"
)

// QueryOptimizer optimizes database queries for performance
type QueryOptimizer struct {
	logger       *zap.Logger
	db           *sql.DB
	queryCache   *QueryCache
	preparedStmts map[string]*sql.Stmt
	indexAdvisor *IndexAdvisor
	metrics      *QueryMetrics
	mu           sync.RWMutex
}

// QueryCache caches query results
type QueryCache struct {
	cache      *ShardedCache
	ttl        time.Duration
	maxSize    int64
	currentSize int64
	mu         sync.RWMutex
}

// IndexAdvisor suggests database indexes
type IndexAdvisor struct {
	logger         *zap.Logger
	db             *sql.DB
	slowQueryLog   []SlowQuery
	suggestedIndexes map[string]IndexSuggestion
	mu             sync.RWMutex
}

// QueryMetrics tracks query performance
type QueryMetrics struct {
	TotalQueries    uint64
	CacheHits       uint64
	CacheMisses     uint64
	SlowQueries     uint64
	QueryDurations  map[string]*DurationStats
	mu              sync.RWMutex
}

// SlowQuery represents a slow query
type SlowQuery struct {
	Query      string
	Duration   time.Duration
	Rows       int64
	Timestamp  time.Time
	ExplainPlan string
}

// IndexSuggestion represents a suggested index
type IndexSuggestion struct {
	TableName   string
	Columns     []string
	Type        string
	Reason      string
	Impact      float64 // Estimated performance improvement
}

// DurationStats tracks query duration statistics
type DurationStats struct {
	Count    uint64
	Total    time.Duration
	Min      time.Duration
	Max      time.Duration
	Avg      time.Duration
}

// NewQueryOptimizer creates a new query optimizer
func NewQueryOptimizer(logger *zap.Logger, db *sql.DB) *QueryOptimizer {
	qo := &QueryOptimizer{
		logger:        logger,
		db:            db,
		preparedStmts: make(map[string]*sql.Stmt),
		metrics: &QueryMetrics{
			QueryDurations: make(map[string]*DurationStats),
		},
	}

	// Initialize query cache
	qo.queryCache = &QueryCache{
		cache:   NewShardedCache(16),
		ttl:     5 * time.Minute,
		maxSize: 100 * 1024 * 1024, // 100MB
	}

	// Initialize index advisor
	qo.indexAdvisor = &IndexAdvisor{
		logger:           logger,
		db:               db,
		suggestedIndexes: make(map[string]IndexSuggestion),
	}

	return qo
}

// OptimizeQuery optimizes and executes a query
func (qo *QueryOptimizer) OptimizeQuery(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	startTime := time.Now()
	defer func() {
		qo.recordQueryMetrics(query, time.Since(startTime))
	}()

	// Check cache first
	cacheKey := qo.generateCacheKey(query, args...)
	if cached, found := qo.queryCache.Get(cacheKey); found {
		qo.metrics.CacheHits++
		return cached.(*sql.Rows), nil
	}
	qo.metrics.CacheMisses++

	// Optimize query
	optimizedQuery := qo.optimizeQueryString(query)

	// Use prepared statement if available
	rows, err := qo.executePrepared(ctx, optimizedQuery, args...)
	if err != nil {
		return nil, err
	}

	// Analyze slow queries
	duration := time.Since(startTime)
	if duration > 100*time.Millisecond {
		qo.analyzeSlowQuery(query, duration)
	}

	return rows, nil
}

// BatchInsert performs optimized batch insert
func (qo *QueryOptimizer) BatchInsert(ctx context.Context, table string, columns []string, values [][]interface{}) error {
	if len(values) == 0 {
		return nil
	}

	// Build batch insert query
	valueStrings := make([]string, 0, len(values))
	valueArgs := make([]interface{}, 0, len(values)*len(columns))
	
	for i, v := range values {
		placeholders := make([]string, len(columns))
		for j := range columns {
			placeholders[j] = fmt.Sprintf("$%d", i*len(columns)+j+1)
			valueArgs = append(valueArgs, v[j])
		}
		valueStrings = append(valueStrings, fmt.Sprintf("(%s)", strings.Join(placeholders, ",")))
	}

	query := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES %s",
		table,
		strings.Join(columns, ","),
		strings.Join(valueStrings, ","),
	)

	// Use COPY for very large batches
	if len(values) > 1000 {
		return qo.bulkCopy(ctx, table, columns, values)
	}

	_, err := qo.db.ExecContext(ctx, query, valueArgs...)
	return err
}

// bulkCopy uses PostgreSQL COPY for bulk inserts
func (qo *QueryOptimizer) bulkCopy(ctx context.Context, table string, columns []string, values [][]interface{}) error {
	txn, err := qo.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer txn.Rollback()

	stmt, err := txn.Prepare(pq.CopyIn(table, columns...))
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, row := range values {
		if _, err := stmt.Exec(row...); err != nil {
			return err
		}
	}

	if _, err := stmt.Exec(); err != nil {
		return err
	}

	return txn.Commit()
}

// CreateIndex creates an index based on advisor suggestions
func (qo *QueryOptimizer) CreateIndex(ctx context.Context, suggestion IndexSuggestion) error {
	indexName := fmt.Sprintf("idx_%s_%s", suggestion.TableName, strings.Join(suggestion.Columns, "_"))
	
	query := fmt.Sprintf(
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s (%s)",
		indexName,
		suggestion.TableName,
		strings.Join(suggestion.Columns, ", "),
	)

	if suggestion.Type != "" {
		query += fmt.Sprintf(" USING %s", suggestion.Type)
	}

	qo.logger.Info("Creating index",
		zap.String("index", indexName),
		zap.String("reason", suggestion.Reason),
		zap.Float64("impact", suggestion.Impact),
	)

	_, err := qo.db.ExecContext(ctx, query)
	return err
}

// AnalyzeTable updates table statistics
func (qo *QueryOptimizer) AnalyzeTable(ctx context.Context, table string) error {
	query := fmt.Sprintf("ANALYZE %s", table)
	_, err := qo.db.ExecContext(ctx, query)
	return err
}

// GetSlowQueries returns recent slow queries
func (qo *QueryOptimizer) GetSlowQueries(limit int) []SlowQuery {
	qo.indexAdvisor.mu.RLock()
	defer qo.indexAdvisor.mu.RUnlock()

	if limit > len(qo.indexAdvisor.slowQueryLog) {
		limit = len(qo.indexAdvisor.slowQueryLog)
	}

	result := make([]SlowQuery, limit)
	copy(result, qo.indexAdvisor.slowQueryLog[len(qo.indexAdvisor.slowQueryLog)-limit:])
	return result
}

// GetIndexSuggestions returns index suggestions
func (qo *QueryOptimizer) GetIndexSuggestions() []IndexSuggestion {
	qo.indexAdvisor.mu.RLock()
	defer qo.indexAdvisor.mu.RUnlock()

	suggestions := make([]IndexSuggestion, 0, len(qo.indexAdvisor.suggestedIndexes))
	for _, suggestion := range qo.indexAdvisor.suggestedIndexes {
		suggestions = append(suggestions, suggestion)
	}

	// Sort by impact
	for i := 0; i < len(suggestions)-1; i++ {
		for j := i + 1; j < len(suggestions); j++ {
			if suggestions[j].Impact > suggestions[i].Impact {
				suggestions[i], suggestions[j] = suggestions[j], suggestions[i]
			}
		}
	}

	return suggestions
}

// Helper methods

func (qo *QueryOptimizer) optimizeQueryString(query string) string {
	// Simple query optimizations
	optimized := query

	// Remove unnecessary whitespace
	optimized = strings.TrimSpace(optimized)
	optimized = strings.ReplaceAll(optimized, "  ", " ")

	// Add LIMIT if SELECT without LIMIT
	if strings.HasPrefix(strings.ToUpper(optimized), "SELECT") &&
		!strings.Contains(strings.ToUpper(optimized), "LIMIT") {
		// Be careful with this optimization
		// Only for specific known queries
	}

	return optimized
}

func (qo *QueryOptimizer) executePrepared(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	qo.mu.RLock()
	stmt, exists := qo.preparedStmts[query]
	qo.mu.RUnlock()

	if !exists {
		// Prepare statement
		var err error
		stmt, err = qo.db.PrepareContext(ctx, query)
		if err != nil {
			return nil, err
		}

		qo.mu.Lock()
		qo.preparedStmts[query] = stmt
		qo.mu.Unlock()
	}

	return stmt.QueryContext(ctx, args...)
}

func (qo *QueryOptimizer) generateCacheKey(query string, args ...interface{}) string {
	key := query
	for _, arg := range args {
		key += fmt.Sprintf(":%v", arg)
	}
	return key
}

func (qo *QueryOptimizer) recordQueryMetrics(query string, duration time.Duration) {
	qo.metrics.mu.Lock()
	defer qo.metrics.mu.Unlock()

	qo.metrics.TotalQueries++

	stats, exists := qo.metrics.QueryDurations[query]
	if !exists {
		stats = &DurationStats{
			Min: duration,
			Max: duration,
		}
		qo.metrics.QueryDurations[query] = stats
	}

	stats.Count++
	stats.Total += duration
	stats.Avg = stats.Total / time.Duration(stats.Count)

	if duration < stats.Min {
		stats.Min = duration
	}
	if duration > stats.Max {
		stats.Max = duration
	}

	if duration > 100*time.Millisecond {
		qo.metrics.SlowQueries++
	}
}

func (qo *QueryOptimizer) analyzeSlowQuery(query string, duration time.Duration) {
	// Get query execution plan
	explainQuery := fmt.Sprintf("EXPLAIN ANALYZE %s", query)
	rows, err := qo.db.Query(explainQuery)
	if err != nil {
		qo.logger.Warn("Failed to explain query",
			zap.String("query", query),
			zap.Error(err),
		)
		return
	}
	defer rows.Close()

	var explainPlan strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			continue
		}
		explainPlan.WriteString(line + "\n")
	}

	slowQuery := SlowQuery{
		Query:       query,
		Duration:    duration,
		Timestamp:   time.Now(),
		ExplainPlan: explainPlan.String(),
	}

	qo.indexAdvisor.mu.Lock()
	qo.indexAdvisor.slowQueryLog = append(qo.indexAdvisor.slowQueryLog, slowQuery)
	
	// Keep only last 1000 slow queries
	if len(qo.indexAdvisor.slowQueryLog) > 1000 {
		qo.indexAdvisor.slowQueryLog = qo.indexAdvisor.slowQueryLog[len(qo.indexAdvisor.slowQueryLog)-1000:]
	}
	qo.indexAdvisor.mu.Unlock()

	// Analyze for index suggestions
	qo.suggestIndexes(slowQuery)
}

func (qo *QueryOptimizer) suggestIndexes(slowQuery SlowQuery) {
	// Simple index suggestion based on query patterns
	query := strings.ToUpper(slowQuery.Query)

	// Look for WHERE clauses without indexes
	if strings.Contains(query, "WHERE") && strings.Contains(slowQuery.ExplainPlan, "Seq Scan") {
		// Extract table and column from query
		// This is a simplified version - real implementation would use SQL parser
		
		if strings.Contains(query, "SHARES") && strings.Contains(query, "WORKER_ID") {
			suggestion := IndexSuggestion{
				TableName: "shares",
				Columns:   []string{"worker_id", "created_at"},
				Type:      "btree",
				Reason:    "Sequential scan detected on frequently queried columns",
				Impact:    0.8,
			}
			
			qo.indexAdvisor.mu.Lock()
			qo.indexAdvisor.suggestedIndexes["shares_worker_id"] = suggestion
			qo.indexAdvisor.mu.Unlock()
		}
	}
}

// QueryCache methods

func (qc *QueryCache) Get(key string) (interface{}, bool) {
	return qc.cache.Get(key)
}

func (qc *QueryCache) Set(key string, value interface{}, size int64) {
	qc.mu.Lock()
	defer qc.mu.Unlock()

	// Check cache size limit
	if qc.currentSize+size > qc.maxSize {
		// Evict old entries
		// Simple implementation - in production use LRU
		qc.cache = NewShardedCache(16)
		qc.currentSize = 0
	}

	qc.cache.Set(key, value, qc.ttl)
	qc.currentSize += size
}

// GetMetrics returns query optimizer metrics
func (qo *QueryOptimizer) GetMetrics() map[string]interface{} {
	qo.metrics.mu.RLock()
	defer qo.metrics.mu.RUnlock()

	metrics := map[string]interface{}{
		"total_queries": qo.metrics.TotalQueries,
		"cache_hits":    qo.metrics.CacheHits,
		"cache_misses":  qo.metrics.CacheMisses,
		"slow_queries":  qo.metrics.SlowQueries,
		"cache_hit_rate": float64(qo.metrics.CacheHits) / float64(qo.metrics.TotalQueries),
	}

	// Add top slow queries
	topSlow := make([]map[string]interface{}, 0, 5)
	for query, stats := range qo.metrics.QueryDurations {
		if stats.Avg > 50*time.Millisecond {
			topSlow = append(topSlow, map[string]interface{}{
				"query":     query,
				"avg_ms":    stats.Avg.Milliseconds(),
				"max_ms":    stats.Max.Milliseconds(),
				"count":     stats.Count,
			})
		}
	}
	metrics["top_slow_queries"] = topSlow

	return metrics
}