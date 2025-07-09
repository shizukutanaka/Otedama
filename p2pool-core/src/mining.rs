// Mining primitives for P2Pool
// 
// Core mining data structures following KISS principle

use crate::{Error, Result, Algorithm, Difficulty, Address, BlockHash, TxHash, ShareId};
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use sha2::{Sha256, Digest};

/// Mining share submitted by a miner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Share {
    pub id: ShareId,
    pub miner_address: Address,
    pub block_hash: BlockHash,
    pub share_hash: String,
    pub difficulty: Difficulty,
    pub timestamp: DateTime<Utc>,
    pub nonce: u64,
    pub extra_nonce: String,
    pub valid: bool,
}

impl Share {
    /// Create a new share
    pub fn new(
        miner_address: Address,
        block_hash: BlockHash,
        difficulty: Difficulty,
        nonce: u64,
        extra_nonce: String,
    ) -> Self {
        let mut share = Self {
            id: String::new(),
            miner_address,
            block_hash,
            share_hash: String::new(),
            difficulty,
            timestamp: Utc::now(),
            nonce,
            extra_nonce,
            valid: false,
        };
        
        // Generate share ID and hash
        share.id = share.generate_id();
        share.share_hash = share.calculate_hash();
        
        share
    }
    
    /// Generate unique share ID
    fn generate_id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.miner_address.as_bytes());
        hasher.update(self.block_hash.as_bytes());
        hasher.update(self.nonce.to_le_bytes());
        hasher.update(self.extra_nonce.as_bytes());
        hasher.update(self.timestamp.timestamp().to_le_bytes());
        
        format!("{:x}", hasher.finalize())
    }
    
    /// Calculate share hash
    fn calculate_hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.block_hash.as_bytes());
        hasher.update(self.nonce.to_le_bytes());
        hasher.update(self.extra_nonce.as_bytes());
        
        format!("{:x}", hasher.finalize())
    }
    
    /// Validate the share
    pub fn validate(&mut self, target_difficulty: Difficulty) -> Result<bool> {
        // Recalculate hash to ensure integrity
        let calculated_hash = self.calculate_hash();
        if calculated_hash != self.share_hash {
            self.valid = false;
            return Ok(false);
        }
        
        // Check difficulty
        let share_difficulty = self.calculate_difficulty()?;
        self.valid = share_difficulty >= target_difficulty;
        
        Ok(self.valid)
    }
    
    /// Calculate difficulty from share hash
    pub fn calculate_difficulty(&self) -> Result<Difficulty> {
        let hash_bytes = hex::decode(&self.share_hash)
            .map_err(|e| Error::mining(format!("Invalid share hash: {}", e)))?;
        
        if hash_bytes.len() != 32 {
            return Err(Error::mining("Invalid hash length"));
        }
        
        // Convert to big integer for difficulty calculation
        let mut target = [0u8; 32];
        target.copy_from_slice(&hash_bytes);
        target.reverse(); // Convert to big-endian
        
        // Calculate difficulty as maximum target / current target
        let max_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000u128;
        let current_target = u128::from_be_bytes([
            target[16], target[17], target[18], target[19],
            target[20], target[21], target[22], target[23],
            target[24], target[25], target[26], target[27],
            target[28], target[29], target[30], target[31],
        ]);
        
        if current_target == 0 {
            return Ok(f64::INFINITY);
        }
        
        Ok(max_target as f64 / current_target as f64)
    }
}

/// Block found by the pool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub hash: BlockHash,
    pub height: u64,
    pub difficulty: Difficulty,
    pub timestamp: DateTime<Utc>,
    pub miner_address: Address,
    pub reward: u64, // satoshis
    pub fees: u64,   // satoshis
    pub share_count: usize,
    pub confirmed: bool,
}

impl Block {
    /// Create a new block
    pub fn new(
        hash: BlockHash,
        height: u64,
        difficulty: Difficulty,
        miner_address: Address,
        reward: u64,
        fees: u64,
        share_count: usize,
    ) -> Self {
        Self {
            hash,
            height,
            difficulty,
            timestamp: Utc::now(),
            miner_address,
            reward,
            fees,
            share_count,
            confirmed: false,
        }
    }
    
    /// Get total reward (block reward + fees)
    pub fn total_reward(&self) -> u64 {
        self.reward + self.fees
    }
}

/// Work unit for miners
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkUnit {
    pub job_id: String,
    pub algorithm: Algorithm,
    pub block_template: Vec<u8>,
    pub target_difficulty: Difficulty,
    pub timestamp: DateTime<Utc>,
    pub clean_jobs: bool,
}

impl WorkUnit {
    /// Create a new work unit
    pub fn new(
        algorithm: Algorithm,
        block_template: Vec<u8>,
        target_difficulty: Difficulty,
        clean_jobs: bool,
    ) -> Self {
        let job_id = Self::generate_job_id();
        
        Self {
            job_id,
            algorithm,
            block_template,
            target_difficulty,
            timestamp: Utc::now(),
            clean_jobs,
        }
    }
    
    /// Generate unique job ID
    fn generate_job_id() -> String {
        let mut hasher = Sha256::new();
        hasher.update(Utc::now().timestamp().to_le_bytes());
        hasher.update(rand::random::<u64>().to_le_bytes());
        
        format!("{:x}", hasher.finalize())[..16].to_string()
    }
    
    /// Check if work unit is still valid
    pub fn is_valid(&self, max_age_seconds: u64) -> bool {
        let age = Utc::now().timestamp() - self.timestamp.timestamp();
        age >= 0 && (age as u64) <= max_age_seconds
    }
}

/// Difficulty adjustment calculator
pub struct DifficultyCalculator {
    target_time: u64,
    retarget_interval: u64,
}

impl DifficultyCalculator {
    /// Create new difficulty calculator
    pub fn new(target_time: u64, retarget_interval: u64) -> Self {
        Self {
            target_time,
            retarget_interval,
        }
    }
    
    /// Calculate new difficulty based on share history
    pub fn calculate_new_difficulty(
        &self,
        current_difficulty: Difficulty,
        shares: &[Share],
    ) -> Result<Difficulty> {
        if shares.len() < self.retarget_interval as usize {
            return Ok(current_difficulty);
        }
        
        // Get shares from retarget interval
        let recent_shares = &shares[shares.len() - self.retarget_interval as usize..];
        
        // Calculate actual time taken
        let start_time = recent_shares[0].timestamp;
        let end_time = recent_shares[recent_shares.len() - 1].timestamp;
        let actual_time = (end_time - start_time).num_seconds() as u64;
        
        if actual_time == 0 {
            return Ok(current_difficulty);
        }
        
        // Calculate new difficulty
        let expected_time = self.target_time * self.retarget_interval;
        let adjustment_factor = expected_time as f64 / actual_time as f64;
        
        // Limit adjustment to 4x up or down
        let clamped_factor = adjustment_factor.clamp(0.25, 4.0);
        let new_difficulty = current_difficulty * clamped_factor;
        
        // Ensure minimum difficulty
        Ok(new_difficulty.max(1.0))
    }
}

/// Share validator
pub struct ShareValidator {
    algorithm: Algorithm,
}

impl ShareValidator {
    /// Create new share validator
    pub fn new(algorithm: Algorithm) -> Self {
        Self { algorithm }
    }
    
    /// Validate share according to algorithm
    pub fn validate_share(&self, share: &mut Share, target_difficulty: Difficulty) -> Result<bool> {
        match self.algorithm {
            Algorithm::SHA256 => self.validate_sha256_share(share, target_difficulty),
            Algorithm::RandomX => self.validate_randomx_share(share, target_difficulty),
            Algorithm::Ethash => self.validate_ethash_share(share, target_difficulty),
            Algorithm::Scrypt => self.validate_scrypt_share(share, target_difficulty),
        }
    }
    
    fn validate_sha256_share(&self, share: &mut Share, target_difficulty: Difficulty) -> Result<bool> {
        // SHA256 double hash validation
        share.validate(target_difficulty)
    }
    
    fn validate_randomx_share(&self, _share: &mut Share, _target_difficulty: Difficulty) -> Result<bool> {
        // RandomX validation (simplified for now)
        // In a real implementation, this would use the RandomX library
        Err(Error::mining("RandomX validation not implemented yet"))
    }
    
    fn validate_ethash_share(&self, _share: &mut Share, _target_difficulty: Difficulty) -> Result<bool> {
        // Ethash validation (simplified for now)
        Err(Error::mining("Ethash validation not implemented yet"))
    }
    
    fn validate_scrypt_share(&self, _share: &mut Share, _target_difficulty: Difficulty) -> Result<bool> {
        // Scrypt validation (simplified for now)
        Err(Error::mining("Scrypt validation not implemented yet"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_share_creation() {
        let share = Share::new(
            "1BitcoinAddress".to_string(),
            "blockhash123".to_string(),
            1000.0,
            12345,
            "extranonce".to_string(),
        );
        
        assert!(!share.id.is_empty());
        assert!(!share.share_hash.is_empty());
        assert_eq!(share.difficulty, 1000.0);
        assert_eq!(share.nonce, 12345);
    }
    
    #[test]
    fn test_difficulty_calculator() {
        let calculator = DifficultyCalculator::new(10, 100);
        
        // Test with insufficient shares
        let shares = vec![];
        let new_difficulty = calculator.calculate_new_difficulty(1000.0, &shares).unwrap();
        assert_eq!(new_difficulty, 1000.0);
    }
    
    #[test]
    fn test_work_unit_creation() {
        let work_unit = WorkUnit::new(
            Algorithm::SHA256,
            vec![1, 2, 3, 4],
            1000.0,
            true,
        );
        
        assert!(!work_unit.job_id.is_empty());
        assert_eq!(work_unit.algorithm, Algorithm::SHA256);
        assert_eq!(work_unit.target_difficulty, 1000.0);
    }
}
