// Configuration management for P2Pool
// 
// Simple, practical configuration with sensible defaults

use crate::{Error, Result, Algorithm, PoolConfig};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Main configuration structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub network: NetworkConfig,
    pub mining: MiningConfig,
    pub pool: PoolConfig,
    pub storage: StorageConfig,
    pub api: ApiConfig,
}

/// Network configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub listen_port: u16,
    pub bootstrap_peers: Vec<String>,
    pub max_peers: usize,
    pub connection_timeout: u64,
    pub heartbeat_interval: u64,
}

/// Mining configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiningConfig {
    pub algorithm: Algorithm,
    pub stratum_port: u16,
    pub difficulty_retarget_interval: u64,
    pub min_difficulty: f64,
    pub max_difficulty: f64,
    pub share_target_time: u64, // seconds
}

/// Storage configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    pub database_path: String,
    pub max_db_size: u64, // MB
    pub backup_interval: u64, // seconds
    pub retention_days: u32,
}

/// API configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    pub enabled: bool,
    pub bind_address: String,
    pub port: u16,
    pub enable_cors: bool,
    pub rate_limit: u32, // requests per minute
}

impl Default for Config {
    fn default() -> Self {
        Self {
            network: NetworkConfig::default(),
            mining: MiningConfig::default(),
            pool: PoolConfig::default(),
            storage: StorageConfig::default(),
            api: ApiConfig::default(),
        }
    }
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            listen_port: 37124,
            bootstrap_peers: vec![],
            max_peers: 100,
            connection_timeout: 30,
            heartbeat_interval: 60,
        }
    }
}

impl Default for MiningConfig {
    fn default() -> Self {
        Self {
            algorithm: Algorithm::SHA256,
            stratum_port: 3333,
            difficulty_retarget_interval: 2016, // blocks
            min_difficulty: 1.0,
            max_difficulty: 1e12,
            share_target_time: 10, // 10 seconds
        }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            database_path: "./data/p2pool.db".to_string(),
            max_db_size: 1024, // 1GB
            backup_interval: 3600, // 1 hour
            retention_days: 30,
        }
    }
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bind_address: "127.0.0.1".to_string(),
            port: 8080,
            enable_cors: true,
            rate_limit: 60,
        }
    }
}

impl Config {
    /// Load configuration from file
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| Error::config(format!("Failed to read config file: {}", e)))?;
        
        let config: Config = serde_json::from_str(&content)
            .map_err(|e| Error::config(format!("Failed to parse config file: {}", e)))?;
        
        config.validate()?;
        Ok(config)
    }
    
    /// Save configuration to file
    pub fn save_to_file<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| Error::config(format!("Failed to serialize config: {}", e)))?;
        
        std::fs::write(path, content)
            .map_err(|e| Error::config(format!("Failed to write config file: {}", e)))?;
        
        Ok(())
    }
    
    /// Load from environment variables with defaults
    pub fn from_env() -> Self {
        let mut config = Config::default();
        
        // Network config from env
        if let Ok(port) = std::env::var("P2POOL_PORT") {
            if let Ok(port) = port.parse() {
                config.network.listen_port = port;
            }
        }
        
        // Mining config from env
        if let Ok(algo) = std::env::var("P2POOL_ALGORITHM") {
            match algo.to_uppercase().as_str() {
                "SHA256" => config.mining.algorithm = Algorithm::SHA256,
                "RANDOMX" => config.mining.algorithm = Algorithm::RandomX,
                "ETHASH" => config.mining.algorithm = Algorithm::Ethash,
                "SCRYPT" => config.mining.algorithm = Algorithm::Scrypt,
                _ => {}
            }
        }
        
        if let Ok(port) = std::env::var("STRATUM_PORT") {
            if let Ok(port) = port.parse() {
                config.mining.stratum_port = port;
            }
        }
        
        // Pool config from env
        if let Ok(address) = std::env::var("POOL_ADDRESS") {
            config.pool.pool_address = address;
        }
        
        if let Ok(fee) = std::env::var("POOL_FEE") {
            if let Ok(fee) = fee.parse() {
                config.pool.fee_percentage = fee;
            }
        }
        
        config
    }
    
    /// Validate configuration
    pub fn validate(&self) -> Result<()> {
        if self.network.listen_port == 0 {
            return Err(Error::config("Listen port cannot be 0"));
        }
        
        if self.mining.stratum_port == 0 {
            return Err(Error::config("Stratum port cannot be 0"));
        }
        
        if self.pool.fee_percentage < 0.0 || self.pool.fee_percentage > 100.0 {
            return Err(Error::config("Pool fee must be between 0 and 100 percent"));
        }
        
        if self.pool.min_payout == 0 {
            return Err(Error::config("Minimum payout cannot be 0"));
        }
        
        if self.mining.min_difficulty <= 0.0 {
            return Err(Error::config("Minimum difficulty must be positive"));
        }
        
        if self.mining.max_difficulty <= self.mining.min_difficulty {
            return Err(Error::config("Maximum difficulty must be greater than minimum"));
        }
        
        Ok(())
    }
    
    /// Create configuration file with defaults if it doesn't exist
    pub fn init_config_file<P: AsRef<Path>>(path: P) -> Result<()> {
        if !path.as_ref().exists() {
            let default_config = Config::default();
            default_config.save_to_file(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    
    #[test]
    fn test_default_config_validation() {
        let config = Config::default();
        assert!(config.validate().is_ok());
    }
    
    #[test]
    fn test_config_serialization() {
        let config = Config::default();
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(config.network.listen_port, deserialized.network.listen_port);
    }
    
    #[test]
    fn test_config_file_operations() {
        let temp_file = NamedTempFile::new().unwrap();
        let config = Config::default();
        
        // Save config
        config.save_to_file(temp_file.path()).unwrap();
        
        // Load config
        let loaded_config = Config::load_from_file(temp_file.path()).unwrap();
        assert_eq!(config.network.listen_port, loaded_config.network.listen_port);
    }
}
