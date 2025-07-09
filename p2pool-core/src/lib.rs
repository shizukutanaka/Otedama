// P2P Distributed Mining Pool - Core Library
// 
// Design Philosophy: Keep it simple, fast, and practical
// Following Carmack, Martin, and Pike principles

pub mod config;
pub mod crypto;
pub mod network;
pub mod mining;
pub mod storage;
pub mod consensus;
pub mod metrics;
pub mod types;
pub mod error;

pub use error::{Error, Result};
pub use types::*;

// Re-export commonly used types
pub use mining::{Share, Block, WorkUnit};
pub use network::{P2PNetwork, NetworkConfig};
pub use config::Config;

// Version information
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NAME: &str = env!("CARGO_PKG_NAME");

/// Initialize the library with logging and metrics
pub fn init() -> Result<()> {
    // Setup tracing
    tracing_subscriber::fmt()
        .with_env_filter("p2pool_core=info")
        .init();
    
    tracing::info!("Initializing {} v{}", NAME, VERSION);
    Ok(())
}

/// Core P2Pool instance
pub struct P2Pool {
    network: P2PNetwork,
    config: Config,
}

impl P2Pool {
    /// Create new P2Pool instance
    pub async fn new(config: Config) -> Result<Self> {
        let network = P2PNetwork::new(config.network.clone()).await?;
        
        Ok(Self {
            network,
            config,
        })
    }
    
    /// Start the P2Pool node
    pub async fn start(&mut self) -> Result<()> {
        tracing::info!("Starting P2Pool node");
        
        // Start P2P network
        self.network.start().await?;
        
        tracing::info!("P2Pool node started successfully");
        Ok(())
    }
    
    /// Stop the P2Pool node
    pub async fn stop(&mut self) -> Result<()> {
        tracing::info!("Stopping P2Pool node");
        self.network.stop().await?;
        Ok(())
    }
}
