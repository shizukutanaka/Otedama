// Storage layer for P2Pool
// 
// Simple, reliable data persistence using SQLite and RocksDB

use crate::{Error, Result, Share, Block, Payout, Peer};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tracing::{debug, info, warn};

/// Storage configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    pub database_path: String,
    pub cache_size: usize,
    pub sync_writes: bool,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            database_path: "./data".to_string(),
            cache_size: 1024 * 1024 * 100, // 100MB
            sync_writes: true,
        }
    }
}

/// Storage manager for P2Pool data
pub struct Storage {
    shares_db: rocksdb::DB,
    blocks_db: rocksdb::DB,
    config: StorageConfig,
}

impl Storage {
    /// Create new storage instance
    pub fn new(config: StorageConfig) -> Result<Self> {
        info!("Initializing storage at: {}", config.database_path);
        
        // Create data directory if it doesn't exist
        std::fs::create_dir_all(&config.database_path)
            .map_err(|e| Error::storage(format!("Failed to create data directory: {}", e)))?;
        
        // Configure RocksDB options
        let mut opts = rocksdb::Options::default();
        opts.create_if_missing(true);
        opts.set_write_buffer_size(config.cache_size);
        opts.set_max_write_buffer_number(3);
        opts.set_target_file_size_base(64 * 1024 * 1024);
        opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
        
        // Open shares database
        let shares_path = Path::new(&config.database_path).join("shares");
        let shares_db = rocksdb::DB::open(&opts, shares_path)
            .map_err(|e| Error::storage(format!("Failed to open shares database: {}", e)))?;
        
        // Open blocks database
        let blocks_path = Path::new(&config.database_path).join("blocks");
        let blocks_db = rocksdb::DB::open(&opts, blocks_path)
            .map_err(|e| Error::storage(format!("Failed to open blocks database: {}", e)))?;
        
        Ok(Self {
            shares_db,
            blocks_db,
            config,
        })
    }
    
    /// Store a share
    pub fn store_share(&self, share: &Share) -> Result<()> {
        let key = share.id.as_bytes();
        let value = bincode::serialize(share)
            .map_err(|e| Error::storage(format!("Failed to serialize share: {}", e)))?;
        
        self.shares_db.put(key, value)
            .map_err(|e| Error::storage(format!("Failed to store share: {}", e)))?;
        
        debug!("Stored share: {}", share.id);
        Ok(())
    }
    
    /// Get a share by ID
    pub fn get_share(&self, share_id: &str) -> Result<Option<Share>> {
        let key = share_id.as_bytes();
        
        match self.shares_db.get(key)
            .map_err(|e| Error::storage(format!("Failed to get share: {}", e)))? {
            Some(value) => {
                let share = bincode::deserialize(&value)
                    .map_err(|e| Error::storage(format!("Failed to deserialize share: {}", e)))?;
                Ok(Some(share))
            }
            None => Ok(None),
        }
    }
    
    /// Get shares by miner address
    pub fn get_shares_by_miner(&self, miner_address: &str, limit: usize) -> Result<Vec<Share>> {
        let mut shares = Vec::new();
        let iter = self.shares_db.iterator(rocksdb::IteratorMode::Start);
        
        for item in iter {
            if shares.len() >= limit {
                break;
            }
            
            let (_, value) = item
                .map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            
            let share: Share = bincode::deserialize(&value)
                .map_err(|e| Error::storage(format!("Failed to deserialize share: {}", e)))?;
            
            if share.miner_address == miner_address {
                shares.push(share);
            }
        }
        
        Ok(shares)
    }
    
    /// Get recent shares
    pub fn get_recent_shares(&self, limit: usize) -> Result<Vec<Share>> {
        let mut shares = Vec::new();
        let iter = self.shares_db.iterator(rocksdb::IteratorMode::End);
        
        for item in iter {
            if shares.len() >= limit {
                break;
            }
            
            let (_, value) = item
                .map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            
            let share: Share = bincode::deserialize(&value)
                .map_err(|e| Error::storage(format!("Failed to deserialize share: {}", e)))?;
            
            shares.push(share);
        }
        
        // Reverse to get most recent first
        shares.reverse();
        Ok(shares)
    }
    
    /// Store a block
    pub fn store_block(&self, block: &Block) -> Result<()> {
        let key = block.hash.as_bytes();
        let value = bincode::serialize(block)
            .map_err(|e| Error::storage(format!("Failed to serialize block: {}", e)))?;
        
        self.blocks_db.put(key, value)
            .map_err(|e| Error::storage(format!("Failed to store block: {}", e)))?;
        
        info!("Stored block: {}", block.hash);
        Ok(())
    }
    
    /// Get a block by hash
    pub fn get_block(&self, block_hash: &str) -> Result<Option<Block>> {
        let key = block_hash.as_bytes();
        
        match self.blocks_db.get(key)
            .map_err(|e| Error::storage(format!("Failed to get block: {}", e)))? {
            Some(value) => {
                let block = bincode::deserialize(&value)
                    .map_err(|e| Error::storage(format!("Failed to deserialize block: {}", e)))?;
                Ok(Some(block))
            }
            None => Ok(None),
        }
    }
    
    /// Get recent blocks
    pub fn get_recent_blocks(&self, limit: usize) -> Result<Vec<Block>> {
        let mut blocks = Vec::new();
        let iter = self.blocks_db.iterator(rocksdb::IteratorMode::End);
        
        for item in iter {
            if blocks.len() >= limit {
                break;
            }
            
            let (_, value) = item
                .map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            
            let block: Block = bincode::deserialize(&value)
                .map_err(|e| Error::storage(format!("Failed to deserialize block: {}", e)))?;
            
            blocks.push(block);
        }
        
        // Reverse to get most recent first
        blocks.reverse();
        Ok(blocks)
    }
    
    /// Get storage statistics
    pub fn get_stats(&self) -> Result<StorageStats> {
        let shares_count = self.count_shares()?;
        let blocks_count = self.count_blocks()?;
        
        // Estimate database sizes
        let shares_size = self.estimate_db_size(&self.shares_db)?;
        let blocks_size = self.estimate_db_size(&self.blocks_db)?;
        
        Ok(StorageStats {
            shares_count,
            blocks_count,
            shares_size_mb: shares_size / (1024 * 1024),
            blocks_size_mb: blocks_size / (1024 * 1024),
            last_updated: Utc::now(),
        })
    }
    
    /// Count shares in database
    fn count_shares(&self) -> Result<u64> {
        let mut count = 0;
        let iter = self.shares_db.iterator(rocksdb::IteratorMode::Start);
        
        for item in iter {
            item.map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            count += 1;
        }
        
        Ok(count)
    }
    
    /// Count blocks in database
    fn count_blocks(&self) -> Result<u64> {
        let mut count = 0;
        let iter = self.blocks_db.iterator(rocksdb::IteratorMode::Start);
        
        for item in iter {
            item.map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            count += 1;
        }
        
        Ok(count)
    }
    
    /// Estimate database size
    fn estimate_db_size(&self, db: &rocksdb::DB) -> Result<u64> {
        // This is a rough estimation
        let mut size = 0;
        let iter = db.iterator(rocksdb::IteratorMode::Start);
        
        for item in iter.take(1000) { // Sample first 1000 entries
            let (key, value) = item
                .map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            size += key.len() + value.len();
        }
        
        // Multiply by total count estimate
        let total_count = self.count_shares()? + self.count_blocks()?;
        if total_count > 0 {
            size = (size as u64 * total_count) / 1000.min(total_count);
        }
        
        Ok(size as u64)
    }
    
    /// Cleanup old data
    pub fn cleanup(&self, retention_days: u32) -> Result<u64> {
        let cutoff = Utc::now() - chrono::Duration::days(retention_days as i64);
        let mut deleted = 0;
        
        // Cleanup old shares
        let iter = self.shares_db.iterator(rocksdb::IteratorMode::Start);
        let mut keys_to_delete = Vec::new();
        
        for item in iter {
            let (key, value) = item
                .map_err(|e| Error::storage(format!("Iterator error: {}", e)))?;
            
            let share: Share = match bincode::deserialize(&value) {
                Ok(share) => share,
                Err(_) => continue, // Skip corrupted entries
            };
            
            if share.timestamp < cutoff {
                keys_to_delete.push(key.to_vec());
            }
        }
        
        for key in keys_to_delete {
            self.shares_db.delete(&key)
                .map_err(|e| Error::storage(format!("Failed to delete share: {}", e)))?;
            deleted += 1;
        }
        
        info!("Cleaned up {} old entries", deleted);
        Ok(deleted)
    }
    
    /// Backup database
    pub fn backup<P: AsRef<Path>>(&self, backup_path: P) -> Result<()> {
        info!("Creating backup at: {:?}", backup_path.as_ref());
        
        // Create backup directory
        std::fs::create_dir_all(&backup_path)
            .map_err(|e| Error::storage(format!("Failed to create backup directory: {}", e)))?;
        
        // TODO: Implement proper backup using RocksDB backup engine
        warn!("Backup functionality not fully implemented yet");
        
        Ok(())
    }
}

/// Storage statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageStats {
    pub shares_count: u64,
    pub blocks_count: u64,
    pub shares_size_mb: u64,
    pub blocks_size_mb: u64,
    pub last_updated: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use crate::{Share, Block, Algorithm};
    
    fn create_test_storage() -> (Storage, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config = StorageConfig {
            database_path: temp_dir.path().to_str().unwrap().to_string(),
            cache_size: 1024 * 1024, // 1MB for testing
            sync_writes: false,
        };
        let storage = Storage::new(config).unwrap();
        (storage, temp_dir)
    }
    
    #[test]
    fn test_storage_creation() {
        let (storage, _temp_dir) = create_test_storage();
        let stats = storage.get_stats().unwrap();
        assert_eq!(stats.shares_count, 0);
        assert_eq!(stats.blocks_count, 0);
    }
    
    #[test]
    fn test_share_storage() {
        let (storage, _temp_dir) = create_test_storage();
        
        let share = Share::new(
            "test_address".to_string(),
            "test_block".to_string(),
            1000.0,
            12345,
            "test_extra".to_string(),
        );
        
        // Store share
        storage.store_share(&share).unwrap();
        
        // Retrieve share
        let retrieved = storage.get_share(&share.id).unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, share.id);
    }
    
    #[test]
    fn test_block_storage() {
        let (storage, _temp_dir) = create_test_storage();
        
        let block = Block::new(
            "test_hash".to_string(),
            100,
            1000.0,
            "test_miner".to_string(),
            5000000000,
            100000,
            10,
        );
        
        // Store block
        storage.store_block(&block).unwrap();
        
        // Retrieve block
        let retrieved = storage.get_block(&block.hash).unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().hash, block.hash);
    }
}
