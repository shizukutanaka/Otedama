# Automatic Backup System

## Overview
The Otedama automatic backup system provides comprehensive backup and recovery capabilities for configurations, wallets, and critical data. It supports local and remote storage with encryption and compression.

## Features

### Core Functionality
- **Scheduled Backups**: Automatic backups at configurable intervals
- **Multiple Targets**: Support for local and remote backup destinations
- **Encryption**: AES-256-GCM encryption with scrypt key derivation
- **Compression**: gzip compression with configurable levels
- **Retention Management**: Automatic cleanup of old backups based on age and count
- **Atomic Operations**: All-or-nothing backup operations to prevent partial backups

### Storage Targets
1. **Local Storage**: Fast local filesystem backups
2. **S3/S3-Compatible**: AWS S3, MinIO, or any S3-compatible storage
3. **SFTP**: Secure file transfer to remote servers
4. **WebDAV**: HTTP-based remote storage

### Security Features
- AES-256-GCM encryption for backup data
- Scrypt key derivation for password-based encryption
- Secure password storage with proper file permissions
- Checksum verification for data integrity

## Configuration

Add the following to your `config.yaml`:

```yaml
backup:
  enabled: true
  interval: 12h                    # Backup interval
  retention_days: 30               # Keep backups for 30 days
  max_backups: 100                 # Maximum number of backups to keep
  backup_dir: "./backups"          # Local backup directory
  
  # Paths to backup
  wallet_paths:
    - "./wallets"
    - "./keys"
  data_paths:
    - "./data/blockchain"
    - "./data/shares"
  
  # Encryption settings
  encrypt_backups: true
  password_file: ""                # Leave empty to auto-generate
  compression_level: 6             # 0-9, higher = better compression
  
  # Remote backup (optional)
  remote_enabled: false
  remote_type: "s3"                # s3, sftp, or webdav
  
  # S3 configuration
  s3_endpoint: "https://s3.amazonaws.com"
  s3_bucket: "otedama-backups"
  s3_prefix: "production/"
  s3_access_key: ""
  s3_secret_key: ""
  
  # SFTP configuration
  sftp_host: "backup.example.com"
  sftp_port: 22
  sftp_user: "backup"
  sftp_password: ""
  sftp_key_file: ""
  sftp_path: "/backups/otedama"
  
  # WebDAV configuration
  webdav_url: "https://webdav.example.com/backups"
  webdav_user: ""
  webdav_password: ""
  
  # Notifications
  notify_on_success: false
  notify_on_failure: true
```

## Usage

### Automatic Backups
Once configured and enabled, the system will automatically:
1. Create backups at the specified interval
2. Store them in configured targets
3. Clean up old backups based on retention policy
4. Log all operations for audit trail

### Manual Operations

#### Trigger Immediate Backup
```go
// In your code
err := autoBackup.BackupNow()
```

#### List Available Backups
```go
backups, err := autoBackup.ListBackups()
for _, backup := range backups {
    fmt.Printf("Backup: %s, Size: %d, Time: %s\n", 
        backup.Name, backup.Size, backup.Timestamp)
}
```

#### Restore from Backup
```go
err := autoBackup.RestoreBackup("backup_20250802_150405.tar.gz")
```

## Architecture

### Components

1. **AutoBackup**: Main coordinator managing backup lifecycle
2. **BackupTarget Interface**: Abstraction for different storage backends
3. **LocalBackupTarget**: Local filesystem implementation
4. **S3BackupTarget**: S3-compatible storage implementation
5. **SFTPBackupTarget**: SFTP remote storage implementation
6. **WebDAVBackupTarget**: WebDAV storage implementation

### Backup Process

1. **Collection**: Gather all files from configured paths
2. **Archive**: Create tar archive of collected files
3. **Compression**: Optional gzip compression
4. **Encryption**: Optional AES-256-GCM encryption
5. **Storage**: Save to all configured targets
6. **Verification**: Checksum validation
7. **Cleanup**: Remove old backups per retention policy

### Recovery Process

1. **Retrieval**: Download backup from storage
2. **Verification**: Validate checksum
3. **Decryption**: Decrypt if encrypted
4. **Decompression**: Decompress if compressed
5. **Extraction**: Extract files to original locations
6. **Validation**: Verify restored files

## Best Practices

1. **Regular Testing**: Periodically test backup restoration
2. **Multiple Targets**: Use both local and remote storage
3. **Encryption**: Always enable encryption for sensitive data
4. **Monitoring**: Monitor backup success/failure rates
5. **Documentation**: Document recovery procedures

## Integration

The backup system is integrated into the OtedamaSystem and starts automatically when the system starts. It runs in the background without impacting mining performance.

### System Integration Points
- `internal/core/otedama_system.go`: System initialization and lifecycle
- `internal/config/config.go`: Configuration structures
- `config.yaml`: User configuration

## Performance Considerations

- Backups run in separate goroutines to avoid blocking
- Compression level can be adjusted for CPU/size tradeoff
- Local backups are fast; remote backups may take longer
- Incremental backups not yet supported (future enhancement)

## Security Considerations

- Passwords are never logged or displayed
- Encryption keys are derived using scrypt (memory-hard)
- Remote credentials should use environment variables
- Backup files have restricted permissions (0600)

## Future Enhancements

1. Incremental backups to reduce size
2. Backup verification and integrity checks
3. Email/webhook notifications
4. Backup to blockchain (IPFS)
5. Multi-region replication
6. Point-in-time recovery