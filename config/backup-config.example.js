/**
 * Example configuration for enhanced backup system
 * 
 * Copy this file to backup-config.js and customize settings
 */

export const backupConfig = {
    // Base configuration
    backupDir: './backups',
    tempDir: './temp',
    
    // Backup strategy
    strategy: 'adaptive', // 'simple', 'continuous', 'incremental', 'differential', 'adaptive'
    
    // Scheduling
    enableScheduled: true,
    schedules: {
        hourly: '0 * * * *',     // Every hour
        daily: '0 2 * * *',      // 2 AM daily
        weekly: '0 3 * * 0',     // 3 AM on Sunday
        monthly: '0 4 1 * *'     // 4 AM on 1st of month
    },
    
    // Retention policy
    retention: {
        hourly: 24,    // Keep 24 hourly backups
        daily: 7,      // Keep 7 daily backups
        weekly: 4,     // Keep 4 weekly backups
        monthly: 12,   // Keep 12 monthly backups
        manual: 10,    // Keep 10 manual backups
        minFreeSpace: 5 * 1024 * 1024 * 1024 // 5GB minimum free space
    },
    
    // Compression
    compression: {
        enabled: true,
        level: 6,        // 1-9, where 9 is best compression
        algorithm: 'gzip'
    },
    
    // Encryption (optional)
    encryption: {
        enabled: false,
        password: process.env.BACKUP_ENCRYPTION_KEY,
        algorithm: 'aes-256-gcm'
    },
    
    // Validation
    validation: {
        enabled: true,
        checksumAlgorithm: 'sha256',
        compareWithOriginal: true
    },
    
    // Verification
    verify: {
        enabled: true,
        checksum: true,
        integrity: true
    },
    
    // Adaptive strategy settings
    adaptive: {
        minInterval: 3600000,     // 1 hour minimum
        maxInterval: 86400000,    // 24 hours maximum
        activityThreshold: 1000,  // Operations count
        sizeThreshold: 104857600, // 100MB data changes
        cpuThreshold: 50          // 50% CPU usage threshold
    },
    
    // Resource limits
    resources: {
        maxConcurrent: 1,
        maxCpuPercent: 50,
        maxMemoryMB: 500,
        pauseOnHighLoad: true
    },
    
    // Incremental backup settings
    incremental: {
        enabled: false,
        fullBackupInterval: 7,  // Days between full backups
        maxIncrementals: 6,     // Max incremental backups before full
        trackingInterval: 1000, // Check for changes every second (ms)
        pageSize: 4096,         // Database page size for change tracking
        compression: true,      // Compress incremental backup files
        checksumAlgorithm: 'sha256' // Algorithm for page checksums
    },
    
    // Cloud backup configuration (optional)
    cloud: null
    
    // Example S3 configuration:
    /*
    cloud: {
        provider: 's3',
        region: 'us-east-1',
        endpoint: 'https://s3.amazonaws.com', // Optional custom endpoint
        bucket: 'my-backup-bucket',
        prefix: 'otedama-backups/',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
    */
    
    // Example for S3-compatible services (MinIO, Wasabi, etc):
    /*
    cloud: {
        provider: 's3',
        endpoint: 'https://s3.wasabisys.com',
        region: 'us-east-1',
        bucket: 'my-backup-bucket',
        prefix: 'otedama-backups/',
        accessKeyId: process.env.WASABI_ACCESS_KEY,
        secretAccessKey: process.env.WASABI_SECRET_KEY
    }
    */
};

/**
 * Environment-specific overrides
 */
export const environments = {
    development: {
        retention: {
            hourly: 6,
            daily: 3,
            weekly: 2,
            monthly: 3,
            manual: 5
        },
        compression: {
            enabled: false // Faster backups in dev
        }
    },
    
    production: {
        encryption: {
            enabled: true // Always encrypt in production
        },
        validation: {
            enabled: true,
            compareWithOriginal: true
        },
        cloud: {
            provider: 's3',
            bucket: process.env.PRODUCTION_BACKUP_BUCKET
        }
    }
};

/**
 * Get configuration for current environment
 */
export function getBackupConfig(env = process.env.NODE_ENV || 'development') {
    const envConfig = environments[env] || {};
    return deepMerge(backupConfig, envConfig);
}

/**
 * Deep merge helper
 */
function deepMerge(target, source) {
    const output = { ...target };
    
    for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            output[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            output[key] = source[key];
        }
    }
    
    return output;
}

export default getBackupConfig;