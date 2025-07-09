// Cryptographic utilities for P2Pool
// 
// Simple, secure crypto operations using well-tested libraries

use crate::{Error, Result};
use sha2::{Sha256, Digest};
use ring::{rand, signature};
use serde::{Deserialize, Serialize};

/// Cryptographic key pair for signing
#[derive(Debug, Clone)]
pub struct KeyPair {
    private_key: signature::Ed25519KeyPair,
    public_key: Vec<u8>,
}

impl KeyPair {
    /// Generate new key pair
    pub fn generate() -> Result<Self> {
        let rng = rand::SystemRandom::new();
        let pkcs8_bytes = signature::Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|e| Error::crypto(format!("Key generation failed: {:?}", e)))?;
        
        let private_key = signature::Ed25519KeyPair::from_pkcs8(pkcs8_bytes.as_ref())
            .map_err(|e| Error::crypto(format!("Key parsing failed: {:?}", e)))?;
        
        let public_key = private_key.public_key().as_ref().to_vec();
        
        Ok(Self {
            private_key,
            public_key,
        })
    }
    
    /// Get public key
    pub fn public_key(&self) -> &[u8] {
        &self.public_key
    }
    
    /// Sign data
    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        self.private_key.sign(data).as_ref().to_vec()
    }
    
    /// Verify signature
    pub fn verify(&self, data: &[u8], signature: &[u8]) -> Result<bool> {
        let public_key = signature::UnparsedPublicKey::new(&signature::ED25519, &self.public_key);
        
        match public_key.verify(data, signature) {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        }
    }
}

/// Hash utilities
pub struct HashUtils;

impl HashUtils {
    /// Calculate SHA256 hash
    pub fn sha256(data: &[u8]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hasher.finalize().to_vec()
    }
    
    /// Calculate double SHA256 hash (Bitcoin style)
    pub fn double_sha256(data: &[u8]) -> Vec<u8> {
        let first_hash = Self::sha256(data);
        Self::sha256(&first_hash)
    }
    
    /// Convert hash to hex string
    pub fn to_hex(hash: &[u8]) -> String {
        hex::encode(hash)
    }
    
    /// Convert hex string to hash
    pub fn from_hex(hex_str: &str) -> Result<Vec<u8>> {
        hex::decode(hex_str)
            .map_err(|e| Error::crypto(format!("Invalid hex string: {}", e)))
    }
    
    /// Calculate Merkle root from list of hashes
    pub fn merkle_root(hashes: &[Vec<u8>]) -> Result<Vec<u8>> {
        if hashes.is_empty() {
            return Err(Error::crypto("Cannot calculate Merkle root of empty list"));
        }
        
        let mut current_level = hashes.to_vec();
        
        while current_level.len() > 1 {
            let mut next_level = Vec::new();
            
            for chunk in current_level.chunks(2) {
                let combined = if chunk.len() == 2 {
                    [chunk[0].clone(), chunk[1].clone()].concat()
                } else {
                    // If odd number, duplicate the last hash
                    [chunk[0].clone(), chunk[0].clone()].concat()
                };
                
                next_level.push(Self::double_sha256(&combined));
            }
            
            current_level = next_level;
        }
        
        Ok(current_level.into_iter().next().unwrap())
    }
}

/// Proof of Work utilities
pub struct ProofOfWork;

impl ProofOfWork {
    /// Check if hash meets difficulty target
    pub fn check_proof(hash: &[u8], target_difficulty: f64) -> Result<bool> {
        if hash.len() != 32 {
            return Err(Error::crypto("Invalid hash length"));
        }
        
        // Convert target difficulty to target value
        let target = Self::difficulty_to_target(target_difficulty)?;
        
        // Compare hash with target (both in big-endian)
        Ok(hash <= target.as_slice())
    }
    
    /// Convert difficulty to target
    pub fn difficulty_to_target(difficulty: f64) -> Result<Vec<u8>> {
        if difficulty <= 0.0 {
            return Err(Error::crypto("Difficulty must be positive"));
        }
        
        // Bitcoin's maximum target
        let max_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000u128;
        let target = (max_target as f64 / difficulty) as u128;
        
        // Convert to 32-byte big-endian
        let mut result = [0u8; 32];
        let target_bytes = target.to_be_bytes();
        result[16..].copy_from_slice(&target_bytes);
        
        Ok(result.to_vec())
    }
    
    /// Calculate difficulty from hash
    pub fn hash_to_difficulty(hash: &[u8]) -> Result<f64> {
        if hash.len() != 32 {
            return Err(Error::crypto("Invalid hash length"));
        }
        
        // Convert hash to big-endian u128
        let mut hash_bytes = [0u8; 16];
        hash_bytes.copy_from_slice(&hash[16..]);
        let hash_value = u128::from_be_bytes(hash_bytes);
        
        if hash_value == 0 {
            return Ok(f64::INFINITY);
        }
        
        let max_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000u128;
        Ok(max_target as f64 / hash_value as f64)
    }
}

/// Address utilities
pub struct AddressUtils;

impl AddressUtils {
    /// Validate Bitcoin address format (simplified)
    pub fn validate_bitcoin_address(address: &str) -> bool {
        // Basic validation - in production, use a proper Bitcoin library
        if address.is_empty() || address.len() < 26 || address.len() > 35 {
            return false;
        }
        
        // Check valid characters (Base58)
        address.chars().all(|c| {
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(c)
        })
    }
    
    /// Generate a simple P2Pool address (for testing)
    pub fn generate_p2pool_address() -> String {
        let keypair = KeyPair::generate().unwrap();
        let public_key_hash = HashUtils::sha256(keypair.public_key());
        format!("p2pool_{}", HashUtils::to_hex(&public_key_hash)[..16].to_string())
    }
}

/// Random number generation
pub struct RandomUtils;

impl RandomUtils {
    /// Generate random bytes
    pub fn random_bytes(length: usize) -> Result<Vec<u8>> {
        let rng = rand::SystemRandom::new();
        let mut bytes = vec![0u8; length];
        
        rand::SecureRandom::fill(&rng, &mut bytes)
            .map_err(|e| Error::crypto(format!("Random generation failed: {:?}", e)))?;
        
        Ok(bytes)
    }
    
    /// Generate random u64
    pub fn random_u64() -> Result<u64> {
        let bytes = Self::random_bytes(8)?;
        Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
    }
    
    /// Generate random nonce
    pub fn random_nonce() -> Result<String> {
        let bytes = Self::random_bytes(16)?;
        Ok(HashUtils::to_hex(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_keypair_generation() {
        let keypair = KeyPair::generate().unwrap();
        assert_eq!(keypair.public_key().len(), 32);
    }
    
    #[test]
    fn test_signing_and_verification() {
        let keypair = KeyPair::generate().unwrap();
        let data = b"test message";
        let signature = keypair.sign(data);
        
        assert!(keypair.verify(data, &signature).unwrap());
        assert!(!keypair.verify(b"wrong message", &signature).unwrap());
    }
    
    #[test]
    fn test_hash_functions() {
        let data = b"hello world";
        let hash = HashUtils::sha256(data);
        assert_eq!(hash.len(), 32);
        
        let double_hash = HashUtils::double_sha256(data);
        assert_eq!(double_hash.len(), 32);
        assert_ne!(hash, double_hash);
    }
    
    #[test]
    fn test_merkle_root() {
        let hashes = vec![
            vec![1; 32],
            vec![2; 32],
            vec![3; 32],
        ];
        
        let root = HashUtils::merkle_root(&hashes).unwrap();
        assert_eq!(root.len(), 32);
    }
    
    #[test]
    fn test_proof_of_work() {
        let hash = vec![0u8; 32]; // All zeros - very high difficulty
        assert!(ProofOfWork::check_proof(&hash, 1.0).unwrap());
        
        let hash = vec![255u8; 32]; // All ones - very low difficulty  
        assert!(!ProofOfWork::check_proof(&hash, 1000000.0).unwrap());
    }
    
    #[test]
    fn test_address_validation() {
        assert!(AddressUtils::validate_bitcoin_address("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"));
        assert!(!AddressUtils::validate_bitcoin_address("invalid"));
        assert!(!AddressUtils::validate_bitcoin_address(""));
    }
    
    #[test]
    fn test_random_generation() {
        let bytes1 = RandomUtils::random_bytes(32).unwrap();
        let bytes2 = RandomUtils::random_bytes(32).unwrap();
        
        assert_eq!(bytes1.len(), 32);
        assert_eq!(bytes2.len(), 32);
        assert_ne!(bytes1, bytes2); // Very unlikely to be equal
        
        let num1 = RandomUtils::random_u64().unwrap();
        let num2 = RandomUtils::random_u64().unwrap();
        assert_ne!(num1, num2); // Very unlikely to be equal
    }
}
