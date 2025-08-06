package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// StatisticsRepository handles statistics-related database operations
type StatisticsRepository struct {
	db     *DB
	logger *zap.Logger
}

// Statistic represents a statistical data point
type Statistic struct {
	ID          int64                  `db:"id"`
	Timestamp   time.Time              `db:"timestamp"`
	MetricName  string                 `db:"metric_name"`
	MetricValue float64                `db:"metric_value"`
	WorkerID    *string                `db:"worker_id"`
	Metadata    map[string]interface{} `db:"metadata"`
}

// NewStatisticsRepository creates a new statistics repository
func NewStatisticsRepository(db *DB, logger *zap.Logger) *StatisticsRepository {
	return &StatisticsRepository{
		db:     db,
		logger: logger,
	}
}

// Record records a statistical data point
func (r *StatisticsRepository) Record(ctx context.Context, stat *Statistic) error {
	metadata, _ := json.Marshal(stat.Metadata)
	
	query := `
		INSERT INTO statistics (metric_name, metric_value, worker_id, metadata)
		VALUES (?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO statistics (metric_name, metric_value, worker_id, metadata)
			VALUES ($1, $2, $3, $4)
			RETURNING id, timestamp
		`
		
		err := r.db.QueryRow(ctx, query,
			stat.MetricName,
			stat.MetricValue,
			stat.WorkerID,
			metadata,
		).Scan(&stat.ID, &stat.Timestamp)
		
		return err
	}
	
	result, err := r.db.Execute(ctx, query,
		stat.MetricName,
		stat.MetricValue,
		stat.WorkerID,
		metadata,
	)
	if err != nil {
		return err
	}
	
	stat.ID, err = result.LastInsertId()
	stat.Timestamp = time.Now()
	
	return err
}

// RecordBatch records multiple statistics in a transaction
func (r *StatisticsRepository) RecordBatch(ctx context.Context, stats []*Statistic) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	
	query := `
		INSERT INTO statistics (metric_name, metric_value, worker_id, metadata)
		VALUES (?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO statistics (metric_name, metric_value, worker_id, metadata)
			VALUES ($1, $2, $3, $4)
			RETURNING id, timestamp
		`
	}
	
	for _, stat := range stats {
		metadata, _ := json.Marshal(stat.Metadata)
		
		if r.db.driver == "postgres" {
			err := tx.QueryRow(ctx, query,
				stat.MetricName,
				stat.MetricValue,
				stat.WorkerID,
				metadata,
			).Scan(&stat.ID, &stat.Timestamp)
			
			if err != nil {
				return err
			}
		} else {
			result, err := tx.Execute(ctx, query,
				stat.MetricName,
				stat.MetricValue,
				stat.WorkerID,
				metadata,
			)
			if err != nil {
				return err
			}
			
			stat.ID, err = result.LastInsertId()
			if err != nil {
				return err
			}
			stat.Timestamp = time.Now()
		}
	}
	
	return tx.Commit()
}

// GetMetricTimeSeries retrieves time series data for a metric
func (r *StatisticsRepository) GetMetricTimeSeries(ctx context.Context, metricName string, from, to time.Time, interval time.Duration) ([]TimeSeriesPoint, error) {
	// Build time bucket query based on database type
	var query string
	
	switch r.db.driver {
	case "postgres":
		query = `
			SELECT 
				date_trunc($1, timestamp) as time_bucket,
				AVG(metric_value) as avg_value,
				MIN(metric_value) as min_value,
				MAX(metric_value) as max_value,
				COUNT(*) as count
			FROM statistics
			WHERE metric_name = $2 AND timestamp >= $3 AND timestamp <= $4
			GROUP BY time_bucket
			ORDER BY time_bucket ASC
		`
	case "mysql":
		// MySQL doesn't have date_trunc, use DATE_FORMAT
		intervalFormat := getIntervalFormat(interval)
		query = fmt.Sprintf(`
			SELECT 
				DATE_FORMAT(timestamp, '%s') as time_bucket,
				AVG(metric_value) as avg_value,
				MIN(metric_value) as min_value,
				MAX(metric_value) as max_value,
				COUNT(*) as count
			FROM statistics
			WHERE metric_name = ? AND timestamp >= ? AND timestamp <= ?
			GROUP BY time_bucket
			ORDER BY time_bucket ASC
		`, intervalFormat)
	default: // SQLite
		query = `
			SELECT 
				strftime('%Y-%m-%d %H:00:00', timestamp) as time_bucket,
				AVG(metric_value) as avg_value,
				MIN(metric_value) as min_value,
				MAX(metric_value) as max_value,
				COUNT(*) as count
			FROM statistics
			WHERE metric_name = ? AND timestamp >= ? AND timestamp <= ?
			GROUP BY time_bucket
			ORDER BY time_bucket ASC
		`
	}
	
	var rows *sql.Rows
	var err error
	
	if r.db.driver == "postgres" {
		intervalStr := getPostgresInterval(interval)
		rows, err = r.db.Query(ctx, query, intervalStr, metricName, from, to)
	} else {
		rows, err = r.db.Query(ctx, query, metricName, from, to)
	}
	
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var points []TimeSeriesPoint
	for rows.Next() {
		var point TimeSeriesPoint
		var timeBucket string
		
		err := rows.Scan(
			&timeBucket,
			&point.AvgValue,
			&point.MinValue,
			&point.MaxValue,
			&point.Count,
		)
		if err != nil {
			return nil, err
		}
		
		// Parse time bucket
		point.Timestamp, _ = time.Parse("2006-01-02 15:04:05", timeBucket)
		points = append(points, point)
	}
	
	return points, nil
}

// GetWorkerMetrics retrieves metrics for a specific worker
func (r *StatisticsRepository) GetWorkerMetrics(ctx context.Context, workerID string, from, to time.Time) (map[string][]TimeSeriesPoint, error) {
	query := `
		SELECT metric_name, timestamp, metric_value
		FROM statistics
		WHERE worker_id = ? AND timestamp >= ? AND timestamp <= ?
		ORDER BY metric_name, timestamp ASC
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT metric_name, timestamp, metric_value
			FROM statistics
			WHERE worker_id = $1 AND timestamp >= $2 AND timestamp <= $3
			ORDER BY metric_name, timestamp ASC
		`
	}
	
	rows, err := r.db.Query(ctx, query, workerID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	metrics := make(map[string][]TimeSeriesPoint)
	
	for rows.Next() {
		var metricName string
		var point TimeSeriesPoint
		
		err := rows.Scan(
			&metricName,
			&point.Timestamp,
			&point.AvgValue,
		)
		if err != nil {
			return nil, err
		}
		
		point.MinValue = point.AvgValue
		point.MaxValue = point.AvgValue
		point.Count = 1
		
		metrics[metricName] = append(metrics[metricName], point)
	}
	
	return metrics, nil
}

// GetLatestMetrics retrieves the latest value for each metric
func (r *StatisticsRepository) GetLatestMetrics(ctx context.Context) (map[string]float64, error) {
	query := `
		SELECT DISTINCT metric_name,
		       FIRST_VALUE(metric_value) OVER (PARTITION BY metric_name ORDER BY timestamp DESC) as latest_value
		FROM statistics
		WHERE timestamp >= ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT DISTINCT metric_name,
			       FIRST_VALUE(metric_value) OVER (PARTITION BY metric_name ORDER BY timestamp DESC) as latest_value
			FROM statistics
			WHERE timestamp >= $1
		`
	} else if r.db.driver == "mysql" {
		// MySQL doesn't support FIRST_VALUE in older versions
		query = `
			SELECT s1.metric_name, s1.metric_value as latest_value
			FROM statistics s1
			INNER JOIN (
				SELECT metric_name, MAX(timestamp) as max_timestamp
				FROM statistics
				WHERE timestamp >= ?
				GROUP BY metric_name
			) s2 ON s1.metric_name = s2.metric_name AND s1.timestamp = s2.max_timestamp
		`
	} else {
		// SQLite
		query = `
			SELECT metric_name, metric_value as latest_value
			FROM statistics s1
			WHERE timestamp = (
				SELECT MAX(timestamp)
				FROM statistics s2
				WHERE s2.metric_name = s1.metric_name
				AND timestamp >= ?
			)
			GROUP BY metric_name
		`
	}
	
	// Get metrics from last hour
	from := time.Now().Add(-1 * time.Hour)
	
	rows, err := r.db.Query(ctx, query, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	metrics := make(map[string]float64)
	for rows.Next() {
		var metricName string
		var value float64
		
		err := rows.Scan(&metricName, &value)
		if err != nil {
			return nil, err
		}
		
		metrics[metricName] = value
	}
	
	return metrics, nil
}

// CleanupOld removes old statistics records
func (r *StatisticsRepository) CleanupOld(ctx context.Context, retention time.Duration) error {
	cutoff := time.Now().Add(-retention)
	
	query := `DELETE FROM statistics WHERE timestamp < ?`
	
	if r.db.driver == "postgres" {
		query = `DELETE FROM statistics WHERE timestamp < $1`
	}
	
	result, err := r.db.Execute(ctx, query, cutoff)
	if err != nil {
		return err
	}
	
	affected, _ := result.RowsAffected()
	r.logger.Info("Cleaned up old statistics",
		zap.Int64("records_deleted", affected),
		zap.Duration("retention", retention),
	)
	
	return nil
}

// TimeSeriesPoint represents a point in a time series
type TimeSeriesPoint struct {
	Timestamp time.Time
	AvgValue  float64
	MinValue  float64
	MaxValue  float64
	Count     int64
}

// Helper functions

func getPostgresInterval(d time.Duration) string {
	if d >= 24*time.Hour {
		return "day"
	} else if d >= time.Hour {
		return "hour"
	} else if d >= time.Minute {
		return "minute"
	}
	return "second"
}

func getIntervalFormat(d time.Duration) string {
	if d >= 24*time.Hour {
		return "%Y-%m-%d 00:00:00"
	} else if d >= time.Hour {
		return "%Y-%m-%d %H:00:00"
	} else if d >= time.Minute {
		return "%Y-%m-%d %H:%i:00"
	}
	return "%Y-%m-%d %H:%i:%s"
}