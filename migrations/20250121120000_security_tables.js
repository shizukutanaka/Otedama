/**
 * Security Tables Migration
 * Creates tables for sessions, API keys, and security events
 */

export const name = 'Security Tables';

export function up(db) {
    // Security events table
    db.exec(`
        CREATE TABLE IF NOT EXISTS security_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            level TEXT NOT NULL,
            ip_address TEXT,
            user_id INTEGER,
            data TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_security_events_type_time ON security_events(event_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip_address, created_at DESC);
    `);
    
    // Handle existing api_keys table
    const apiKeysExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'").get();
    if (apiKeysExists) {
        // Rename old table to preserve data
        db.exec(`ALTER TABLE api_keys RENAME TO api_keys_legacy`);
    }
    
    // Create new API keys table
    db.exec(`
        CREATE TABLE api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            key_prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            name TEXT,
            permissions TEXT,
            scopes TEXT,
            rate_limit TEXT,
            ip_whitelist TEXT,
            status TEXT DEFAULT 'active',
            last_used_at DATETIME,
            last_used_ip TEXT,
            usage_count INTEGER DEFAULT 0,
            expires_at DATETIME,
            rotated_from INTEGER,
            rotation_deadline DATETIME,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
        CREATE INDEX IF NOT EXISTS idx_api_keys_user_status ON api_keys(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);
    `);
    
    // API key logs table
    db.exec(`
        CREATE TABLE IF NOT EXISTS api_key_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            api_key_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            endpoint TEXT,
            status_code INTEGER,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_api_key_logs_key_time ON api_key_logs(api_key_id, created_at);
    `);
    
    // Session data table (for database-backed sessions)
    const sessionsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (sessionsExists) {
        db.exec(`ALTER TABLE sessions RENAME TO sessions_legacy`);
    }
    
    db.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            data TEXT,
            fingerprint TEXT,
            ip_address TEXT,
            user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    
    // Rate limit violations table
    db.exec(`
        CREATE TABLE IF NOT EXISTS rate_limit_violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT,
            user_id INTEGER,
            endpoint TEXT,
            violation_type TEXT,
            requests_made INTEGER,
            limit_exceeded INTEGER,
            blocked_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_rate_violations_ip ON rate_limit_violations(ip_address, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_rate_violations_user ON rate_limit_violations(user_id, created_at DESC);
    `);
    
    // CSRF tokens table (for synchronizer pattern)
    db.exec(`
        CREATE TABLE IF NOT EXISTS csrf_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            user_id INTEGER,
            token_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_csrf_tokens_session ON csrf_tokens(session_id);
        CREATE INDEX IF NOT EXISTS idx_csrf_tokens_expires ON csrf_tokens(expires_at);
    `);
}

export function down(db) {
    // Drop indexes first
    db.exec(`
        DROP INDEX IF EXISTS idx_csrf_tokens_expires;
        DROP INDEX IF EXISTS idx_csrf_tokens_session;
        DROP INDEX IF EXISTS idx_rate_violations_user;
        DROP INDEX IF EXISTS idx_rate_violations_ip;
        DROP INDEX IF EXISTS idx_sessions_expires;
        DROP INDEX IF EXISTS idx_sessions_user;
        DROP INDEX IF EXISTS idx_api_key_logs_key_time;
        DROP INDEX IF EXISTS idx_api_keys_expires;
        DROP INDEX IF EXISTS idx_api_keys_user_status;
        DROP INDEX IF EXISTS idx_api_keys_prefix;
        DROP INDEX IF EXISTS idx_security_events_ip;
        DROP INDEX IF EXISTS idx_security_events_user;
        DROP INDEX IF EXISTS idx_security_events_type_time;
    `);
    
    // Drop tables
    db.exec(`
        DROP TABLE IF EXISTS csrf_tokens;
        DROP TABLE IF EXISTS rate_limit_violations;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS api_key_logs;
        DROP TABLE IF EXISTS api_keys;
        DROP TABLE IF EXISTS security_events;
    `);
    
    // Restore legacy tables if they exist
    const legacyApiKeys = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys_legacy'").get();
    if (legacyApiKeys) {
        db.exec(`ALTER TABLE api_keys_legacy RENAME TO api_keys`);
    }
    
    const legacySessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_legacy'").get();
    if (legacySessions) {
        db.exec(`ALTER TABLE sessions_legacy RENAME TO sessions`);
    }
}

export default { up, down, name };