// Consensus mechanisms for P2Pool
// 
// Lightweight consensus for share chain management

use crate::{Error, Result, Share, Block, crypto::HashUtils};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use chrono::{DateTime, Utc};
use tracing::{debug, info, warn};

/// Share chain block (sidechain)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareBlock {
    pub hash: String,
    pub previous_hash: String,
    pub height: u64,
    pub timestamp: DateTime<Utc>,
    pub shares: Vec<Share>,
    pub difficulty: f64,
    pub nonce: u64,
}

impl ShareBlock {
    /// Create new share block
    pub fn new(
        previous_hash: String,
        height: u64,
        shares: Vec<Share>,
        difficulty: f64,
    ) -> Self {
        let mut block = Self {
            hash: String::new(),
            previous_hash,
            height,
            timestamp: Utc::now(),
            shares,
            difficulty,
            nonce: 0,
        };
        
        block.hash = block.calculate_hash();
        block
    }
    
    /// Calculate block hash
    pub fn calculate_hash(&self) -> String {
        let mut data = Vec::new();
        data.extend(self.previous_hash.as_bytes());
        data.extend(self.height.to_le_bytes());
        data.extend(self.timestamp.timestamp().to_le_bytes());
        data.extend(self.difficulty.to_le_bytes());
        data.extend(self.nonce.to_le_bytes());
        
        // Add shares hash
        let shares_data: Vec<_> = self.shares.iter()
            .map(|s| s.id.as_bytes())
            .collect();
        let shares_hash = HashUtils::merkle_root(&shares_data.into_iter().map(|s| s.to_vec()).collect())
            .unwrap_or_default();
        data.extend(shares_hash);
        
        HashUtils::to_hex(&HashUtils::double_sha256(&data))
    }
    
    /// Validate block
    pub fn validate(&self, expected_previous_hash: &str) -> Result<bool> {
        // Check previous hash
        if self.previous_hash != expected_previous_hash {
            return Ok(false);
        }
        
        // Verify hash
        let calculated_hash = self.calculate_hash();
        if calculated_hash != self.hash {
            return Ok(false);
        }
        
        // Check timestamp (not too far in future)
        let now = Utc::now();
        if self.timestamp > now + chrono::Duration::hours(2) {
            return Ok(false);
        }
        
        // Validate all shares
        for share in &self.shares {
            if !share.valid {
                return Ok(false);
            }
        }
        
        Ok(true)
    }
}

/// Share chain manager
pub struct ShareChain {
    blocks: VecDeque<ShareBlock>,
    max_length: usize,
    target_block_time: u64, // seconds
    difficulty_adjustment_interval: u64,
}

impl ShareChain {
    /// Create new share chain
    pub fn new(max_length: usize, target_block_time: u64) -> Self {
        Self {
            blocks: VecDeque::new(),
            max_length,
            target_block_time,
            difficulty_adjustment_interval: 100, // blocks
        }
    }
    
    /// Add share block to chain
    pub fn add_block(&mut self, block: ShareBlock) -> Result<bool> {
        // Validate block
        let expected_previous_hash = self.get_tip_hash();
        if !block.validate(&expected_previous_hash)? {
            return Ok(false);
        }
        
        // Add to chain
        self.blocks.push_back(block.clone());
        
        // Trim chain if too long
        while self.blocks.len() > self.max_length {
            self.blocks.pop_front();
        }
        
        info!("Added share block {} at height {}", block.hash, block.height);
        Ok(true)
    }
    
    /// Get tip (latest) block hash
    pub fn get_tip_hash(&self) -> String {
        self.blocks.back()
            .map(|b| b.hash.clone())
            .unwrap_or_else(|| "genesis".to_string())
    }
    
    /// Get current height
    pub fn get_height(&self) -> u64 {
        self.blocks.back()
            .map(|b| b.height)
            .unwrap_or(0)
    }
    
    /// Get current difficulty
    pub fn get_current_difficulty(&self) -> f64 {
        self.blocks.back()
            .map(|b| b.difficulty)
            .unwrap_or(1.0)
    }
    
    /// Calculate next difficulty
    pub fn calculate_next_difficulty(&self) -> f64 {
        if self.blocks.len() < self.difficulty_adjustment_interval as usize {
            return self.get_current_difficulty();
        }
        
        let recent_blocks: Vec<_> = self.blocks.iter()
            .rev()
            .take(self.difficulty_adjustment_interval as usize)
            .collect();
        
        if recent_blocks.len() < 2 {
            return self.get_current_difficulty();
        }
        
        // Calculate time taken for recent blocks
        let start_time = recent_blocks.last().unwrap().timestamp;
        let end_time = recent_blocks.first().unwrap().timestamp;
        let actual_time = (end_time - start_time).num_seconds() as u64;
        
        if actual_time == 0 {
            return self.get_current_difficulty();
        }
        
        // Calculate expected time
        let expected_time = self.target_block_time * self.difficulty_adjustment_interval;
        
        // Adjust difficulty
        let current_difficulty = self.get_current_difficulty();
        let adjustment_factor = expected_time as f64 / actual_time as f64;
        
        // Limit adjustment to 4x up or down
        let clamped_factor = adjustment_factor.clamp(0.25, 4.0);
        let new_difficulty = current_difficulty * clamped_factor;
        
        // Ensure minimum difficulty
        new_difficulty.max(1.0)
    }
    
    /// Get shares in PPLNS window
    pub fn get_pplns_shares(&self, window_size: usize) -> Vec<Share> {
        let mut shares = Vec::new();
        
        for block in self.blocks.iter().rev() {
            for share in &block.shares {
                shares.push(share.clone());
                if shares.len() >= window_size {
                    break;
                }
            }
            if shares.len() >= window_size {
                break;
            }
        }
        
        shares.truncate(window_size);
        shares
    }
    
    /// Get recent blocks
    pub fn get_recent_blocks(&self, count: usize) -> Vec<ShareBlock> {
        self.blocks.iter()
            .rev()
            .take(count)
            .cloned()
            .collect()
    }
}

/// PPLNS (Pay Per Last N Shares) payout calculator
pub struct PPLNSCalculator {
    window_size: usize,
}

impl PPLNSCalculator {
    /// Create new PPLNS calculator
    pub fn new(window_size: usize) -> Self {
        Self { window_size }
    }
    
    /// Calculate payouts for a block reward
    pub fn calculate_payouts(
        &self,
        share_chain: &ShareChain,
        block_reward: u64,
        pool_fee_percent: f64,
    ) -> Result<HashMap<String, u64>> {
        // Get shares in PPLNS window
        let shares = share_chain.get_pplns_shares(self.window_size);
        
        if shares.is_empty() {
            return Ok(HashMap::new());
        }
        
        // Calculate pool fee
        let pool_fee = ((block_reward as f64) * (pool_fee_percent / 100.0)) as u64;
        let distributable_reward = block_reward - pool_fee;
        
        // Calculate total difficulty
        let total_difficulty: f64 = shares.iter()
            .map(|s| s.difficulty)
            .sum();
        
        if total_difficulty == 0.0 {
            return Ok(HashMap::new());
        }
        
        // Calculate payouts per miner
        let mut miner_difficulty: HashMap<String, f64> = HashMap::new();
        
        for share in &shares {
            *miner_difficulty.entry(share.miner_address.clone()).or_insert(0.0) += share.difficulty;
        }
        
        let mut payouts = HashMap::new();
        
        for (miner_address, difficulty) in miner_difficulty {
            let share_ratio = difficulty / total_difficulty;
            let payout = ((distributable_reward as f64) * share_ratio) as u64;
            
            if payout > 0 {
                payouts.insert(miner_address, payout);
            }
        }
        
        debug!("Calculated payouts for {} miners", payouts.len());
        Ok(payouts)
    }
}

/// Uncle block support (for handling orphaned shares)
pub struct UncleManager {
    uncle_blocks: VecDeque<ShareBlock>,
    max_uncles: usize,
}

impl UncleManager {
    /// Create new uncle manager
    pub fn new(max_uncles: usize) -> Self {
        Self {
            uncle_blocks: VecDeque::new(),
            max_uncles,
        }
    }
    
    /// Add uncle block
    pub fn add_uncle(&mut self, block: ShareBlock) {
        self.uncle_blocks.push_back(block);
        
        while self.uncle_blocks.len() > self.max_uncles {
            self.uncle_blocks.pop_front();
        }
    }
    
    /// Get uncle shares for inclusion in payouts
    pub fn get_uncle_shares(&self, max_age_blocks: u64) -> Vec<Share> {
        let mut shares = Vec::new();
        let current_time = Utc::now();
        let max_age = chrono::Duration::seconds((max_age_blocks * 600) as i64); // Assume 10min blocks
        
        for uncle in &self.uncle_blocks {
            if current_time - uncle.timestamp <= max_age {
                shares.extend(uncle.shares.clone());
            }
        }
        
        shares
    }
    
    /// Clear old uncles
    pub fn cleanup(&mut self, max_age_blocks: u64) {
        let current_time = Utc::now();
        let max_age = chrono::Duration::seconds((max_age_blocks * 600) as i64);
        
        self.uncle_blocks.retain(|uncle| {
            current_time - uncle.timestamp <= max_age
        });
    }
}

/// Consensus manager
pub struct ConsensusManager {
    share_chain: ShareChain,
    pplns_calculator: PPLNSCalculator,
    uncle_manager: UncleManager,
    pending_shares: Vec<Share>,
}

impl ConsensusManager {
    /// Create new consensus manager
    pub fn new(
        chain_length: usize,
        target_block_time: u64,
        pplns_window: usize,
    ) -> Self {
        Self {
            share_chain: ShareChain::new(chain_length, target_block_time),
            pplns_calculator: PPLNSCalculator::new(pplns_window),
            uncle_manager: UncleManager::new(100),
            pending_shares: Vec::new(),
        }
    }
    
    /// Add share to pending pool
    pub fn add_share(&mut self, share: Share) {
        if share.valid {
            self.pending_shares.push(share);
        }
    }
    
    /// Create new share block from pending shares
    pub fn create_share_block(&mut self) -> Result<Option<ShareBlock>> {
        if self.pending_shares.is_empty() {
            return Ok(None);
        }
        
        let previous_hash = self.share_chain.get_tip_hash();
        let height = self.share_chain.get_height() + 1;
        let difficulty = self.share_chain.calculate_next_difficulty();
        
        // Take all pending shares
        let shares = std::mem::take(&mut self.pending_shares);
        
        let block = ShareBlock::new(previous_hash, height, shares, difficulty);
        Ok(Some(block))
    }
    
    /// Process new share block
    pub fn process_share_block(&mut self, block: ShareBlock) -> Result<bool> {
        self.share_chain.add_block(block)
    }
    
    /// Calculate payouts for main chain block
    pub fn calculate_payouts(
        &self,
        block_reward: u64,
        pool_fee_percent: f64,
    ) -> Result<HashMap<String, u64>> {
        self.pplns_calculator.calculate_payouts(
            &self.share_chain,
            block_reward,
            pool_fee_percent,
        )
    }
    
    /// Get current chain status
    pub fn get_status(&self) -> ConsensusStatus {
        ConsensusStatus {
            chain_height: self.share_chain.get_height(),
            current_difficulty: self.share_chain.get_current_difficulty(),
            pending_shares: self.pending_shares.len(),
            tip_hash: self.share_chain.get_tip_hash(),
            uncle_count: self.uncle_manager.uncle_blocks.len(),
        }
    }
}

/// Consensus status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusStatus {
    pub chain_height: u64,
    pub current_difficulty: f64,
    pub pending_shares: usize,
    pub tip_hash: String,
    pub uncle_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mining::Share;
    
    #[test]
    fn test_share_block_creation() {
        let shares = vec![
            Share::new(
                "miner1".to_string(),
                "block1".to_string(),
                1000.0,
                12345,
                "extra1".to_string(),
            ),
        ];
        
        let block = ShareBlock::new(
            "previous_hash".to_string(),
            1,
            shares,
            1000.0,
        );
        
        assert!(!block.hash.is_empty());
        assert_eq!(block.height, 1);
        assert_eq!(block.shares.len(), 1);
    }
    
    #[test]
    fn test_share_chain() {
        let mut chain = ShareChain::new(100, 10);
        
        let block = ShareBlock::new(
            "genesis".to_string(),
            1,
            vec![],
            1000.0,
        );
        
        assert!(chain.add_block(block).unwrap());
        assert_eq!(chain.get_height(), 1);
        assert_eq!(chain.get_current_difficulty(), 1000.0);
    }
    
    #[test]
    fn test_pplns_calculator() {
        let calculator = PPLNSCalculator::new(100);
        let mut chain = ShareChain::new(100, 10);
        
        // Add a block with shares
        let shares = vec![
            Share::new(
                "miner1".to_string(),
                "block1".to_string(),
                1000.0,
                12345,
                "extra1".to_string(),
            ),
            Share::new(
                "miner2".to_string(),
                "block1".to_string(),
                500.0,
                12346,
                "extra2".to_string(),
            ),
        ];
        
        let block = ShareBlock::new(
            "genesis".to_string(),
            1,
            shares,
            1000.0,
        );
        
        chain.add_block(block).unwrap();
        
        let payouts = calculator.calculate_payouts(&chain, 5000000000, 1.0).unwrap();
        assert!(!payouts.is_empty());
    }
}
