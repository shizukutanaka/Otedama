package backup

import (
	"time"
)

// BackupConfig contains configuration for backup operations
type BackupConfig struct {
	// Basic settings
	EnableRealtime     bool          `json:"enable_realtime"`
	AutoBackup         bool          `json:"auto_backup"`
	MaxBackups         int           `json:"max_backups"`
	
	// Storage settings
	StorageLocations   []StorageLocation `json:"storage_locations"`
	BackupLocations    []string          `json:"backup_locations"`
	RedundancyLevel    int               `json:"redundancy_level"`
	RedundantCopies    int               `json:"redundant_copies"`
	
	// Compression settings
	CompressionEnabled bool  `json:"compression_enabled"`
	CompressionLevel   int   `json:"compression_level"`
	
	// Encryption settings
	EncryptionEnabled  bool   `json:"encryption_enabled"`
	EncryptionKey      []byte `json:"encryption_key,omitempty"`
	
	// Scheduling and retention
	BackupInterval     time.Duration   `json:"backup_interval"`
	RetentionPeriod    time.Duration   `json:"retention_period"`
	RetentionDays      int             `json:"retention_days"`
	MaxBackupAge       time.Duration   `json:"max_backup_age"`
	RetentionPolicy    RetentionPolicy `json:"retention_policy"`
	
	// Size and performance limits
	MaxBackupSize      int64         `json:"max_backup_size"`
	BandwidthLimit     int64         `json:"bandwidth_limit"`
	NetworkTimeout     time.Duration `json:"network_timeout"`
	MaxConcurrent      int           `json:"max_concurrent"`
	
	// Validation and integrity
	IntegrityCheck     bool          `json:"integrity_check"`
	VerifyAfterBackup  bool          `json:"verify_after_backup"`
	ChecksumAlgorithm  string        `json:"checksum_algorithm"`
	
	// Performance tuning
	BufferSize         int           `json:"buffer_size"`
	ParallelStreams    int           `json:"parallel_streams"`
}

// StorageLocation represents a backup storage location configuration
type StorageLocation struct {
	ID         string                 `json:"id"`
	Type       string                 `json:"type"`
	Path       string                 `json:"path"`
	Priority   int                    `json:"priority"`
	MaxSize    int64                  `json:"max_size"`
	Credentials map[string]string     `json:"credentials,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// RetentionPolicy defines how backups are retained
type RetentionPolicy struct {
	Type            string `json:"type"`
	KeepDaily       int    `json:"keep_daily"`
	KeepWeekly      int    `json:"keep_weekly"`
	KeepMonthly     int    `json:"keep_monthly"`
	KeepYearly      int    `json:"keep_yearly"`
	MinBackups      int    `json:"min_backups"`
	MaxBackups      int    `json:"max_backups"`
}

// BackupMetadata contains metadata for a backup
type BackupMetadata struct {
	ID             string                 `json:"id"`
	MinerID        string                 `json:"miner_id"`
	Timestamp      time.Time              `json:"timestamp"`
	Size           int64                  `json:"size"`
	CompressedSize int64                  `json:"compressed_size"`
	Hash           string                 `json:"hash"`
	Version        string                 `json:"version"`
	Type           string                 `json:"type"`
	Status         string                 `json:"status"`
	Location       string                 `json:"location"`
	Encrypted      bool                   `json:"encrypted"`
	Compressed     bool                   `json:"compressed"`
	Checksum       string                 `json:"checksum"`
	Tags           []string               `json:"tags"`
	Metadata       map[string]interface{} `json:"metadata"`
}

// BackupData represents backup data with metadata
type BackupData struct {
	Metadata BackupMetadata `json:"metadata"`
	Data     []byte         `json:"data"`
}

// BackupLocation represents a backup storage location
type BackupLocation struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	Path       string    `json:"path"`
	Status     string    `json:"status"`
	Priority   int       `json:"priority"`
	Capacity   int64     `json:"capacity"`
	Used       int64     `json:"used"`
	Available  int64     `json:"available"`
	LastCheck  time.Time `json:"last_check"`
	LastBackup time.Time `json:"last_backup"`
}

// BackupJob represents a backup job
type BackupJob struct {
	ID           string                 `json:"id"`
	Type         string                 `json:"type"`
	Status       string                 `json:"status"`
	Progress     float64                `json:"progress"`
	StartTime    time.Time              `json:"start_time"`
	EndTime      *time.Time             `json:"end_time,omitempty"`
	Error        string                 `json:"error,omitempty"`
	SourcePath   string                 `json:"source_path"`
	TargetPath   string                 `json:"target_path"`
	Size         int64                  `json:"size"`
	ProcessedSize int64                 `json:"processed_size"`
	Details      map[string]interface{} `json:"details"`
}

// BackupStats contains backup statistics
type BackupStats struct {
	TotalBackups      int       `json:"total_backups"`
	SuccessfulBackups int       `json:"successful_backups"`
	FailedBackups     int       `json:"failed_backups"`
	TotalSize         int64     `json:"total_size"`
	CompressedSize    int64     `json:"compressed_size"`
	LastBackup        time.Time `json:"last_backup"`
	NextBackup        time.Time `json:"next_backup"`
	BackupRate        float64   `json:"backup_rate"`
}

// BackupStatus represents the current status of backup operations
type BackupStatus struct {
	Healthy         bool       `json:"healthy"`
	ActiveJobs      int        `json:"active_jobs"`
	PendingJobs     int        `json:"pending_jobs"`
	LastSuccess     time.Time  `json:"last_success"`
	LastFailure     *time.Time `json:"last_failure,omitempty"`
	FailureReason   string     `json:"failure_reason,omitempty"`
	StorageStatus   string     `json:"storage_status"`
	EncryptionStatus string    `json:"encryption_status"`
}

// BackupSchedule defines a backup schedule
type BackupSchedule struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	Type      string        `json:"type"`
	Interval  time.Duration `json:"interval"`
	NextRun   time.Time     `json:"next_run"`
	LastRun   *time.Time    `json:"last_run,omitempty"`
	Enabled   bool          `json:"enabled"`
	Targets   []string      `json:"targets"`
	Config    BackupConfig  `json:"config"`
}

// BackupHealth represents the health of backup systems
type BackupHealth struct {
	Status           string    `json:"status"`
	HealthScore      float64   `json:"health_score"`
	LastCheck        time.Time `json:"last_check"`
	BackupLocations  []BackupLocationHealth `json:"backup_locations"`
	Issues           []string  `json:"issues"`
	Recommendations  []string  `json:"recommendations"`
}

// BackupLocationHealth represents health of a specific backup location
type BackupLocationHealth struct {
	LocationID   string    `json:"location_id"`
	Status       string    `json:"status"`
	Available    bool      `json:"available"`
	ResponseTime int64     `json:"response_time_ms"`
	FreeSpace    int64     `json:"free_space"`
	LastSuccess  time.Time `json:"last_success"`
}

// BackupTask represents a backup task
type BackupTask struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Priority    int                    `json:"priority"`
	Status      string                 `json:"status"`
	CreatedAt   time.Time              `json:"created_at"`
	ScheduledAt time.Time              `json:"scheduled_at"`
	StartedAt   *time.Time             `json:"started_at,omitempty"`
	CompletedAt *time.Time             `json:"completed_at,omitempty"`
	Retries     int                    `json:"retries"`
	MaxRetries  int                    `json:"max_retries"`
	Config      BackupConfig           `json:"config"`
	Context     map[string]interface{} `json:"context"`
}

// EmergencyBackup represents an emergency backup
type EmergencyBackup struct {
	ID           string    `json:"id"`
	Timestamp    time.Time `json:"timestamp"`
	Reason       string    `json:"reason"`
	Type         string    `json:"type"`
	Priority     string    `json:"priority"`
	DataSnapshot []byte    `json:"data_snapshot"`
	Metadata     BackupMetadata `json:"metadata"`
}

// BackupResult represents the result of a backup operation
type BackupResult struct {
	Success   bool           `json:"success"`
	BackupID  string         `json:"backup_id"`
	Location  string         `json:"location"`
	Size      int64          `json:"size"`
	Duration  time.Duration  `json:"duration"`
	Error     error          `json:"error,omitempty"`
	Metadata  BackupMetadata `json:"metadata"`
}

// RestoreRequest represents a request to restore from backup
type RestoreRequest struct {
	BackupID    string                 `json:"backup_id"`
	TargetPath  string                 `json:"target_path"`
	Options     RestoreOptions         `json:"options"`
	Context     map[string]interface{} `json:"context"`
}

// RestoreOptions contains options for restore operations
type RestoreOptions struct {
	OverwriteExisting bool      `json:"overwrite_existing"`
	VerifyChecksum    bool      `json:"verify_checksum"`
	RestorePermissions bool     `json:"restore_permissions"`
	RestoreTimestamp  bool      `json:"restore_timestamp"`
	TargetTime        *time.Time `json:"target_time,omitempty"`
}

// RestoreResult represents the result of a restore operation
type RestoreResult struct {
	Success       bool          `json:"success"`
	RestoredFiles int           `json:"restored_files"`
	TotalSize     int64         `json:"total_size"`
	Duration      time.Duration `json:"duration"`
	Error         error         `json:"error,omitempty"`
}