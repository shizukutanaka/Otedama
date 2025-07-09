// P2Pool - P2P Distributed Mining Pool
// 
// Main entry point following UNIX philosophy: do one thing well

use clap::Parser;
use p2pool_core::{Config, P2Pool, Result};
use std::path::PathBuf;
use tracing::{info, error};

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Configuration file path
    #[arg(short, long, default_value = "config.json")]
    config: PathBuf,
    
    /// Pool address for mining rewards
    #[arg(short, long)]
    pool_address: Option<String>,
    
    /// Mining algorithm
    #[arg(short, long)]
    algorithm: Option<String>,
    
    /// P2P network port
    #[arg(short, long)]
    port: Option<u16>,
    
    /// Stratum mining port
    #[arg(short, long)]
    stratum_port: Option<u16>,
    
    /// Enable debug logging
    #[arg(short, long)]
    debug: bool,
    
    /// Generate default configuration file
    #[arg(long)]
    init_config: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    
    // Initialize library
    p2pool_core::init()?;
    
    // Setup logging level
    if args.debug {
        std::env::set_var("RUST_LOG", "p2pool_core=debug,p2pool=debug");
    }
    
    // Generate default config if requested
    if args.init_config {
        info!("Generating default configuration file: {:?}", args.config);
        Config::init_config_file(&args.config)?;
        println!("Configuration file created: {:?}", args.config);
        return Ok(());
    }
    
    // Load configuration
    let mut config = if args.config.exists() {
        info!("Loading configuration from: {:?}", args.config);
        Config::load_from_file(&args.config)?
    } else {
        info!("Using default configuration");
        Config::from_env()
    };
    
    // Override config with command line arguments
    if let Some(pool_address) = args.pool_address {
        config.pool.pool_address = pool_address;
    }
    
    if let Some(algorithm) = args.algorithm {
        match algorithm.to_uppercase().as_str() {
            "SHA256" => config.mining.algorithm = p2pool_core::Algorithm::SHA256,
            "RANDOMX" => config.mining.algorithm = p2pool_core::Algorithm::RandomX,
            "ETHASH" => config.mining.algorithm = p2pool_core::Algorithm::Ethash,
            "SCRYPT" => config.mining.algorithm = p2pool_core::Algorithm::Scrypt,
            _ => {
                error!("Unsupported algorithm: {}", algorithm);
                std::process::exit(1);
            }
        }
    }
    
    if let Some(port) = args.port {
        config.network.listen_port = port;
    }
    
    if let Some(stratum_port) = args.stratum_port {
        config.mining.stratum_port = stratum_port;
    }
    
    // Validate configuration
    config.validate()?;
    
    // Create and start P2Pool
    info!("Starting P2Pool with configuration:");
    info!("  Pool address: {}", config.pool.pool_address);
    info!("  Algorithm: {}", config.mining.algorithm.as_str());
    info!("  P2P port: {}", config.network.listen_port);
    info!("  Stratum port: {}", config.mining.stratum_port);
    info!("  Max peers: {}", config.network.max_peers);
    
    let mut p2pool = P2Pool::new(config).await?;
    
    // Setup graceful shutdown
    let shutdown = setup_shutdown_handler();
    
    tokio::select! {
        result = p2pool.start() => {
            if let Err(e) = result {
                error!("P2Pool error: {}", e);
                std::process::exit(1);
            }
        }
        _ = shutdown => {
            info!("Shutdown signal received");
        }
    }
    
    // Stop P2Pool
    p2pool.stop().await?;
    info!("P2Pool stopped");
    
    Ok(())
}

/// Setup graceful shutdown handler
async fn setup_shutdown_handler() {
    #[cfg(unix)]
    {
        use tokio::signal::unix;
        let mut sigterm = match unix::signal(unix::SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                tokio::signal::ctrl_c().await.expect("Failed to install Ctrl+C handler");
                return;
            }
        };
        
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("Received Ctrl+C");
            }
            _ = sigterm.recv() => {
                info!("Received SIGTERM");
            }
        }
    }
    
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.expect("Failed to install Ctrl+C handler");
        info!("Received Ctrl+C");
    }
}
