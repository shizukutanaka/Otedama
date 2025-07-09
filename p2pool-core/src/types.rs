// Core data types for P2Pool
// 
// Simple, well-defined types following clean architecture principles

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use chrono::{DateTime, Utc};

/// Unique identifier for a peer in the network
pub type PeerId = String;

/// Bitcoin address
pub type Address = String;

/// Transaction hash
pub type TxHash = String;

/// Block hash
pub type BlockHash = String;

/// Mining difficulty
pub type Difficulty = f64;

/// Hash rate in hashes per second
pub type HashRate = u64;

/// Share ID
pub type ShareId = String;

/// Peer information in the P2P network
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: PeerId,
    pub address: String,
    pub port: u16,
    pub last_seen: DateTime<Utc>,
    pub hash_rate: HashRate,
    pub shares_submitted: u64,
    pub reputation: f64,
}

impl Peer {
    pub fn new(id: PeerId, address: String, port: u16) -> Self {
        Self {
            id,
            address,
            port,
            last_seen: Utc::now(),
            hash_rate: 0,
            shares_submitted: 0,
            reputation: 1.0,
        }
    }
}

/// Network statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStats {
    pub connected_peers: usize,
    pub total_hash_rate: HashRate,
    pub shares_per_second: u64,
    pub blocks_found: u64,
    pub network_difficulty: Difficulty,
    pub last_block_time: Option<DateTime<Utc>>,
}

impl Default for NetworkStats {
    fn default() -> Self {
        Self {
            connected_peers: 0,
            total_hash_rate: 0,
            shares_per_second: 0,
            blocks_found: 0,
            network_difficulty: 1.0,
            last_block_time: None,
        }
    }
}

/// Pool configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    pub pool_address: Address,
    pub fee_percentage: f64,
    pub min_payout: u64,
    pub share_window_size: usize,
    pub target_block_time: u64, // in seconds
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            pool_address: String::new(),
            fee_percentage: 1.0,
            min_payout: 10000, // satoshis
            share_window_size: 2160, // ~6 hours
            target_block_time: 10, // 10 seconds for sidechain
        }
    }
}

/// Payout information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payout {
    pub address: Address,
    pub amount: u64, // satoshis
    pub timestamp: DateTime<Utc>,
    pub tx_hash: Option<TxHash>,
}

impl Payout {
    pub fn new(address: Address, amount: u64) -> Self {
        Self {
            address,
            amount,
            timestamp: Utc::now(),
            tx_hash: None,
        }
    }
}

/// P2Pool node status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NodeStatus {
    Starting,
    Syncing,
    Running,
    Stopping,
    Stopped,
    Error(String),
}

/// Mining algorithm type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Algorithm {
    SHA256,     // Bitcoin
    RandomX,    // Monero
    Ethash,     // Ethereum (historical)
    Scrypt,     // Litecoin
}

impl Algorithm {
    pub fn as_str(&self) -> &'static str {
        match self {
            Algorithm::SHA256 => "SHA256",
            Algorithm::RandomX => "RandomX",
            Algorithm::Ethash => "Ethash",
            Algorithm::Scrypt => "Scrypt",
        }
    }
}

/// P2Pool event types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum P2PoolEvent {
    PeerConnected(PeerId),
    PeerDisconnected(PeerId),
    ShareReceived(ShareId),
    BlockFound(BlockHash),
    PayoutProcessed(Payout),
    NetworkStatsUpdated(NetworkStats),
}
