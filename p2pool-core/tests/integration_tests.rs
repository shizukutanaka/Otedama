// Integration tests for P2Pool Core
//
// Testing the complete system integration following test-driven principles

use p2pool_core::*;
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::sleep;

#[tokio::test]
async fn test_p2pool_startup_and_basic_operations() {
    // Initialize logging for tests
    let _ = tracing_subscriber::fmt::try_init();
    
    // Create temporary directory for test data
    let temp_dir = TempDir::new().unwrap();
    let data_path = temp_dir.path().to_str().unwrap();
    
    // Create test configuration
    let mut config = Config::default();
    config.storage.database_path = format!("{}/test.db", data_path);
    config.network.listen_port = 0; // Use random port for testing
    config.pool.pool_address = "1TestBitcoinAddress".to_string();
    
    // Test configuration validation
    assert!(config.validate().is_ok());
    
    // Test P2Pool creation
    let p2pool_result = P2Pool::new(config).await;
    assert!(p2pool_result.is_ok());
    
    let mut p2pool = p2pool_result.unwrap();
    
    // Test startup (but don't actually start network to avoid port conflicts)
    // In real tests, we would mock the network layer
    
    println!("✅ P2Pool startup test passed");
}

#[tokio::test]
async fn test_share_validation_and_processing() {
    use p2pool_core::mining::*;
    use p2pool_core::crypto::*;
    
    // Create test share
    let mut share = Share::new(
        "1TestMinerAddress".to_string(),
        "000000000000000000000000000000000000000000000000000000000000abcd".to_string(),
        1000.0,
        12345,
        "deadbeef".to_string(),
    );
    
    // Test share validation
    let validation_result = share.validate(500.0); // Lower difficulty for testing
    assert!(validation_result.is_ok());
    
    // Test share hash calculation
    assert!(!share.share_hash.is_empty());
    assert!(!share.id.is_empty());
    
    // Test difficulty calculation
    let difficulty_result = share.calculate_difficulty();
    assert!(difficulty_result.is_ok());
    
    println!("✅ Share validation test passed");
}

#[tokio::test]
async fn test_consensus_and_pplns() {
    use p2pool_core::consensus::*;
    use p2pool_core::mining::Share;
    
    // Create consensus manager
    let mut consensus = ConsensusManager::new(1000, 10, 100);
    
    // Create test shares
    for i in 0..10 {
        let mut share = Share::new(
            format!("1TestMiner{}", i % 3), // 3 different miners
            "testblockhash".to_string(),
            1000.0,
            12345 + i,
            format!("extra{}", i),
        );
        share.valid = true; // Mark as valid for testing
        
        consensus.add_share(share);
    }
    
    // Test share block creation
    let block_result = consensus.create_share_block();
    assert!(block_result.is_ok());
    
    let block = block_result.unwrap();
    assert!(block.is_some());
    
    if let Some(share_block) = block {
        assert_eq!(share_block.shares.len(), 10);
        
        // Test block processing
        let process_result = consensus.process_share_block(share_block);
        assert!(process_result.is_ok());
        assert!(process_result.unwrap());
    }
    
    // Test PPLNS payout calculation
    let payouts = consensus.calculate_payouts(5000000000, 1.0);
    assert!(payouts.is_ok());
    
    let payout_map = payouts.unwrap();
    assert!(!payout_map.is_empty());
    
    println!("✅ Consensus and PPLNS test passed");
}

#[tokio::test]
async fn test_storage_operations() {
    use p2pool_core::storage::*;
    use p2pool_core::mining::{Share, Block};
    use tempfile::TempDir;
    
    // Create temporary storage
    let temp_dir = TempDir::new().unwrap();
    let config = StorageConfig {
        database_path: temp_dir.path().to_str().unwrap().to_string(),
        cache_size: 1024 * 1024,
        sync_writes: false,
    };
    
    let storage = Storage::new(config);
    assert!(storage.is_ok());
    let storage = storage.unwrap();
    
    // Test share storage
    let share = Share::new(
        "1TestMinerAddress".to_string(),
        "testblockhash".to_string(),
        1000.0,
        12345,
        "testextra".to_string(),
    );
    
    assert!(storage.store_share(&share).is_ok());
    
    // Test share retrieval
    let retrieved_share = storage.get_share(&share.id);
    assert!(retrieved_share.is_ok());
    assert!(retrieved_share.unwrap().is_some());
    
    // Test block storage
    let block = Block::new(
        "testblockhash123".to_string(),
        100,
        1000.0,
        "1TestMinerAddress".to_string(),
        5000000000,
        100000,
        10,
    );
    
    assert!(storage.store_block(&block).is_ok());
    
    // Test block retrieval
    let retrieved_block = storage.get_block(&block.hash);
    assert!(retrieved_block.is_ok());
    assert!(retrieved_block.unwrap().is_some());
    
    // Test statistics
    let stats = storage.get_stats();
    assert!(stats.is_ok());
    
    println!("✅ Storage operations test passed");
}

#[tokio::test]
async fn test_cryptographic_functions() {
    use p2pool_core::crypto::*;
    
    // Test key pair generation
    let keypair = KeyPair::generate();
    assert!(keypair.is_ok());
    let keypair = keypair.unwrap();
    
    // Test signing and verification
    let message = b"test message for p2pool";
    let signature = keypair.sign(message);
    
    let verification = keypair.verify(message, &signature);
    assert!(verification.is_ok());
    assert!(verification.unwrap());
    
    // Test hash functions
    let data = b"test data";
    let hash = HashUtils::sha256(data);
    assert_eq!(hash.len(), 32);
    
    let double_hash = HashUtils::double_sha256(data);
    assert_eq!(double_hash.len(), 32);
    assert_ne!(hash, double_hash);
    
    // Test Merkle root calculation
    let hashes = vec![
        vec![1; 32],
        vec![2; 32],
        vec![3; 32],
        vec![4; 32],
    ];
    
    let merkle_root = HashUtils::merkle_root(&hashes);
    assert!(merkle_root.is_ok());
    assert_eq!(merkle_root.unwrap().len(), 32);
    
    // Test proof of work functions
    let easy_hash = vec![0u8; 32]; // Very easy hash
    let pow_check = ProofOfWork::check_proof(&easy_hash, 1.0);
    assert!(pow_check.is_ok());
    assert!(pow_check.unwrap());
    
    // Test address validation
    assert!(AddressUtils::validate_bitcoin_address("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"));
    assert!(!AddressUtils::validate_bitcoin_address("invalid_address"));
    
    // Test random generation
    let random_bytes = RandomUtils::random_bytes(32);
    assert!(random_bytes.is_ok());
    assert_eq!(random_bytes.unwrap().len(), 32);
    
    println!("✅ Cryptographic functions test passed");
}

#[tokio::test]
async fn test_metrics_collection() {
    use p2pool_core::metrics::*;
    
    // Test metrics collector
    let collector = MetricsCollector::new();
    
    collector.counter("test_counter", 5, "Test counter metric");
    collector.gauge("test_gauge", 3.14, "Test gauge metric");
    collector.increment_counter("test_incremental", "Incremental counter");
    collector.increment_counter("test_incremental", "Incremental counter");
    
    // Test metric retrieval
    let counter_metric = collector.get_metric("test_counter");
    assert!(counter_metric.is_some());
    
    let incremental_metric = collector.get_metric("test_incremental");
    assert!(incremental_metric.is_some());
    
    if let Some(metric) = incremental_metric {
        if let MetricValue::Counter(value) = metric.value {
            assert_eq!(value, 2);
        } else {
            panic!("Expected counter value");
        }
    }
    
    // Test Prometheus export
    let prometheus_output = collector.export_prometheus();
    assert!(prometheus_output.contains("test_counter"));
    assert!(prometheus_output.contains("test_gauge"));
    assert!(prometheus_output.contains("test_incremental"));
    
    // Test P2Pool specific metrics
    let p2pool_metrics = P2PoolMetrics::new();
    p2pool_metrics.share_received("1TestMiner", 1000.0);
    p2pool_metrics.block_found(100, 5000000000);
    p2pool_metrics.peer_connected(5);
    
    let p2pool_output = p2pool_metrics.export_prometheus();
    assert!(p2pool_output.contains("p2pool_shares_total"));
    assert!(p2pool_output.contains("p2pool_blocks_total"));
    
    println!("✅ Metrics collection test passed");
}

#[tokio::test]
async fn test_difficulty_adjustment() {
    use p2pool_core::mining::*;
    
    // Create difficulty calculator
    let calculator = DifficultyCalculator::new(10, 10); // 10 second target, 10 share window
    
    // Create test shares with different timestamps
    let mut shares = Vec::new();
    let base_time = chrono::Utc::now();
    
    for i in 0..15 {
        let mut share = Share::new(
            "1TestMiner".to_string(),
            "testblock".to_string(),
            1000.0,
            12345 + i,
            format!("extra{}", i),
        );
        
        // Simulate shares coming in faster than target (5 seconds apart instead of 10)
        share.timestamp = base_time + chrono::Duration::seconds(i as i64 * 5);
        shares.push(share);
    }
    
    // Test difficulty adjustment
    let new_difficulty = calculator.calculate_new_difficulty(1000.0, &shares);
    assert!(new_difficulty.is_ok());
    
    let adjusted_difficulty = new_difficulty.unwrap();
    // Since shares are coming in faster, difficulty should increase
    assert!(adjusted_difficulty > 1000.0);
    
    println!("✅ Difficulty adjustment test passed");
}

#[tokio::test]
async fn test_config_management() {
    use tempfile::NamedTempFile;
    
    // Test default configuration
    let default_config = Config::default();
    assert!(default_config.validate().is_ok());
    
    // Test configuration file operations
    let temp_file = NamedTempFile::new().unwrap();
    
    // Save configuration
    let save_result = default_config.save_to_file(temp_file.path());
    assert!(save_result.is_ok());
    
    // Load configuration
    let loaded_config = Config::load_from_file(temp_file.path());
    assert!(loaded_config.is_ok());
    
    let config = loaded_config.unwrap();
    assert_eq!(config.network.listen_port, default_config.network.listen_port);
    
    // Test environment variable loading
    std::env::set_var("P2POOL_PORT", "12345");
    std::env::set_var("STRATUM_PORT", "54321");
    std::env::set_var("POOL_ADDRESS", "1TestPoolAddress");
    
    let env_config = Config::from_env();
    assert_eq!(env_config.network.listen_port, 12345);
    assert_eq!(env_config.mining.stratum_port, 54321);
    assert_eq!(env_config.pool.pool_address, "1TestPoolAddress");
    
    // Clean up environment variables
    std::env::remove_var("P2POOL_PORT");
    std::env::remove_var("STRATUM_PORT");
    std::env::remove_var("POOL_ADDRESS");
    
    println!("✅ Configuration management test passed");
}

#[tokio::test]
async fn test_performance_benchmarks() {
    use p2pool_core::mining::*;
    use std::time::Instant;
    
    // Benchmark share creation
    let start = Instant::now();
    let mut shares = Vec::new();
    
    for i in 0..1000 {
        let share = Share::new(
            format!("1TestMiner{}", i % 10),
            "testblockhash".to_string(),
            1000.0,
            12345 + i,
            format!("extra{}", i),
        );
        shares.push(share);
    }
    
    let creation_time = start.elapsed();
    println!("⚡ Created 1000 shares in {:?}", creation_time);
    assert!(creation_time.as_millis() < 1000); // Should complete in less than 1 second
    
    // Benchmark share validation
    let start = Instant::now();
    let mut valid_count = 0;
    
    for mut share in shares {
        if let Ok(is_valid) = share.validate(500.0) {
            if is_valid {
                valid_count += 1;
            }
        }
    }
    
    let validation_time = start.elapsed();
    println!("⚡ Validated 1000 shares in {:?}", validation_time);
    println!("⚡ Valid shares: {}/1000", valid_count);
    assert!(validation_time.as_millis() < 2000); // Should complete in less than 2 seconds
    
    println!("✅ Performance benchmarks passed");
}

// Integration test that simulates a complete mining scenario
#[tokio::test]
async fn test_complete_mining_scenario() {
    use p2pool_core::consensus::*;
    use p2pool_core::mining::*;
    use p2pool_core::storage::*;
    use tempfile::TempDir;
    
    println!("🔄 Running complete mining scenario test...");
    
    // Setup
    let temp_dir = TempDir::new().unwrap();
    let storage_config = StorageConfig {
        database_path: temp_dir.path().to_str().unwrap().to_string(),
        cache_size: 1024 * 1024,
        sync_writes: false,
    };
    
    let storage = Storage::new(storage_config).unwrap();
    let mut consensus = ConsensusManager::new(100, 10, 50);
    
    // Simulate mining activity
    let miners = vec!["1MinerA", "1MinerB", "1MinerC"];
    let mut total_shares = 0;
    
    for round in 0..5 {
        println!("📦 Mining round {}", round + 1);
        
        // Each miner submits shares
        for (i, miner) in miners.iter().enumerate() {
            for share_num in 0..3 {
                let mut share = Share::new(
                    miner.to_string(),
                    format!("block_{}", round),
                    1000.0 + (i * 100) as f64, // Different difficulties per miner
                    (round * 1000 + i * 100 + share_num) as u64,
                    format!("extra_{}_{}", miner, share_num),
                );
                
                // Simulate share validation
                share.valid = share.validate(500.0).unwrap_or(false);
                
                if share.valid {
                    // Store share
                    storage.store_share(&share).unwrap();
                    
                    // Add to consensus
                    consensus.add_share(share);
                    total_shares += 1;
                }
            }
        }
        
        // Create share block for this round
        if let Ok(Some(share_block)) = consensus.create_share_block() {
            println!("🧱 Created share block with {} shares", share_block.shares.len());
            
            // Process the block
            consensus.process_share_block(share_block).unwrap();
        }
        
        // Simulate finding a main chain block occasionally
        if round == 2 {
            let block = Block::new(
                format!("mainchain_block_{}", round),
                100 + round,
                2000.0,
                miners[round % miners.len()].to_string(),
                5000000000,
                150000,
                total_shares,
            );
            
            storage.store_block(&block).unwrap();
            
            // Calculate payouts
            let payouts = consensus.calculate_payouts(block.total_reward(), 1.0).unwrap();
            println!("💰 Calculated payouts for {} miners", payouts.len());
            
            for (address, amount) in &payouts {
                println!("  {} -> {} satoshis", address, amount);
            }
        }
    }
    
    // Verify final state
    let stats = storage.get_stats().unwrap();
    println!("📊 Final statistics:");
    println!("  Total shares stored: {}", stats.shares_count);
    println!("  Total blocks stored: {}", stats.blocks_count);
    
    let consensus_status = consensus.get_status();
    println!("  Chain height: {}", consensus_status.chain_height);
    println!("  Current difficulty: {}", consensus_status.current_difficulty);
    
    assert!(stats.shares_count > 0);
    assert!(consensus_status.chain_height > 0);
    
    println!("✅ Complete mining scenario test passed");
}

// Run all tests
#[tokio::test]
async fn test_all_systems() {
    println!("🧪 Running comprehensive P2Pool test suite...");
    
    // This test orchestrates all other tests
    test_p2pool_startup_and_basic_operations().await;
    test_share_validation_and_processing().await;
    test_consensus_and_pplns().await;
    test_storage_operations().await;
    test_cryptographic_functions().await;
    test_metrics_collection().await;
    test_difficulty_adjustment().await;
    test_config_management().await;
    test_performance_benchmarks().await;
    test_complete_mining_scenario().await;
    
    println!("🎉 All P2Pool tests passed successfully!");
}
