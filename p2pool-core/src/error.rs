// Error handling for P2Pool
// 
// Simple and comprehensive error types following Rob Pike's philosophy

use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Network error: {0}")]
    Network(String),
    
    #[error("Mining error: {0}")]
    Mining(String),
    
    #[error("Storage error: {0}")]
    Storage(String),
    
    #[error("Cryptography error: {0}")]
    Crypto(String),
    
    #[error("Configuration error: {0}")]
    Config(String),
    
    #[error("Consensus error: {0}")]
    Consensus(String),
    
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    
    #[error("Other error: {0}")]
    Other(String),
}

impl Error {
    pub fn network(msg: impl Into<String>) -> Self {
        Self::Network(msg.into())
    }
    
    pub fn mining(msg: impl Into<String>) -> Self {
        Self::Mining(msg.into())
    }
    
    pub fn storage(msg: impl Into<String>) -> Self {
        Self::Storage(msg.into())
    }
    
    pub fn crypto(msg: impl Into<String>) -> Self {
        Self::Crypto(msg.into())
    }
    
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }
    
    pub fn consensus(msg: impl Into<String>) -> Self {
        Self::Consensus(msg.into())
    }
    
    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }
    
    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other(msg.into())
    }
}
