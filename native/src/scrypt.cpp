#include <cstdint>
#include <cstring>
#include <vector>

// Salsa20/8 core function
static void salsa20_8(uint32_t B[16]) {
    uint32_t x[16];
    memcpy(x, B, 64);
    
    for (int i = 0; i < 8; i += 2) {
        // Column round
        x[4] ^= ((x[0] + x[12]) << 7) | ((x[0] + x[12]) >> 25);
        x[8] ^= ((x[4] + x[0]) << 9) | ((x[4] + x[0]) >> 23);
        x[12] ^= ((x[8] + x[4]) << 13) | ((x[8] + x[4]) >> 19);
        x[0] ^= ((x[12] + x[8]) << 18) | ((x[12] + x[8]) >> 14);
        
        x[9] ^= ((x[5] + x[1]) << 7) | ((x[5] + x[1]) >> 25);
        x[13] ^= ((x[9] + x[5]) << 9) | ((x[9] + x[5]) >> 23);
        x[1] ^= ((x[13] + x[9]) << 13) | ((x[13] + x[9]) >> 19);
        x[5] ^= ((x[1] + x[13]) << 18) | ((x[1] + x[13]) >> 14);
        
        x[14] ^= ((x[10] + x[6]) << 7) | ((x[10] + x[6]) >> 25);
        x[2] ^= ((x[14] + x[10]) << 9) | ((x[14] + x[10]) >> 23);
        x[6] ^= ((x[2] + x[14]) << 13) | ((x[2] + x[14]) >> 19);
        x[10] ^= ((x[6] + x[2]) << 18) | ((x[6] + x[2]) >> 14);
        
        x[3] ^= ((x[15] + x[11]) << 7) | ((x[15] + x[11]) >> 25);
        x[7] ^= ((x[3] + x[15]) << 9) | ((x[3] + x[15]) >> 23);
        x[11] ^= ((x[7] + x[3]) << 13) | ((x[7] + x[3]) >> 19);
        x[15] ^= ((x[11] + x[7]) << 18) | ((x[11] + x[7]) >> 14);
        
        // Row round
        x[1] ^= ((x[0] + x[3]) << 7) | ((x[0] + x[3]) >> 25);
        x[2] ^= ((x[1] + x[0]) << 9) | ((x[1] + x[0]) >> 23);
        x[3] ^= ((x[2] + x[1]) << 13) | ((x[2] + x[1]) >> 19);
        x[0] ^= ((x[3] + x[2]) << 18) | ((x[3] + x[2]) >> 14);
        
        x[6] ^= ((x[5] + x[4]) << 7) | ((x[5] + x[4]) >> 25);
        x[7] ^= ((x[6] + x[5]) << 9) | ((x[6] + x[5]) >> 23);
        x[4] ^= ((x[7] + x[6]) << 13) | ((x[7] + x[6]) >> 19);
        x[5] ^= ((x[4] + x[7]) << 18) | ((x[4] + x[7]) >> 14);
        
        x[11] ^= ((x[10] + x[9]) << 7) | ((x[10] + x[9]) >> 25);
        x[8] ^= ((x[11] + x[10]) << 9) | ((x[11] + x[10]) >> 23);
        x[9] ^= ((x[8] + x[11]) << 13) | ((x[8] + x[11]) >> 19);
        x[10] ^= ((x[9] + x[8]) << 18) | ((x[9] + x[8]) >> 14);
        
        x[12] ^= ((x[15] + x[14]) << 7) | ((x[15] + x[14]) >> 25);
        x[13] ^= ((x[12] + x[15]) << 9) | ((x[12] + x[15]) >> 23);
        x[14] ^= ((x[13] + x[12]) << 13) | ((x[13] + x[12]) >> 19);
        x[15] ^= ((x[14] + x[13]) << 18) | ((x[14] + x[13]) >> 14);
    }
    
    for (int i = 0; i < 16; i++) {
        B[i] += x[i];
    }
}

// Block mix function
static void scrypt_block_mix(uint32_t* B, uint32_t* Y, int r) {
    uint32_t X[16];
    
    // Copy last block
    memcpy(X, &B[(2 * r - 1) * 16], 64);
    
    for (int i = 0; i < 2 * r; i++) {
        // XOR with current block
        for (int j = 0; j < 16; j++) {
            X[j] ^= B[i * 16 + j];
        }
        
        // Apply Salsa20/8
        salsa20_8(X);
        
        // Copy to output
        memcpy(&Y[i * 16], X, 64);
    }
    
    // Reorder blocks
    for (int i = 0; i < r; i++) {
        memcpy(&B[i * 16], &Y[i * 2 * 16], 64);
        memcpy(&B[(i + r) * 16], &Y[(i * 2 + 1) * 16], 64);
    }
}

// ROMix function
static void scrypt_romix(uint8_t* B, int r, int N) {
    uint32_t* X = (uint32_t*)B;
    std::vector<uint32_t> V(32 * r * N);
    std::vector<uint32_t> Y(32 * r);
    
    // Copy input to X
    for (int i = 0; i < 32 * r; i++) {
        X[i] = ((uint32_t)B[i * 4] << 0) |
               ((uint32_t)B[i * 4 + 1] << 8) |
               ((uint32_t)B[i * 4 + 2] << 16) |
               ((uint32_t)B[i * 4 + 3] << 24);
    }
    
    // Build V array
    for (int i = 0; i < N; i++) {
        memcpy(&V[i * 32 * r], X, 128 * r);
        scrypt_block_mix(X, Y.data(), r);
    }
    
    // Mix with random V elements
    for (int i = 0; i < N; i++) {
        int j = X[16 * (2 * r - 1)] & (N - 1);
        for (int k = 0; k < 32 * r; k++) {
            X[k] ^= V[j * 32 * r + k];
        }
        scrypt_block_mix(X, Y.data(), r);
    }
    
    // Copy result back
    for (int i = 0; i < 32 * r; i++) {
        B[i * 4] = (X[i] >> 0) & 0xFF;
        B[i * 4 + 1] = (X[i] >> 8) & 0xFF;
        B[i * 4 + 2] = (X[i] >> 16) & 0xFF;
        B[i * 4 + 3] = (X[i] >> 24) & 0xFF;
    }
}

// Simplified PBKDF2 for scrypt
static void pbkdf2_sha256(const uint8_t* password, size_t passlen,
                         const uint8_t* salt, size_t saltlen,
                         uint8_t* out, size_t outlen) {
    // This is a simplified version - real implementation would use proper PBKDF2
    // For now, just do simple SHA256
    extern void sha256_hash(const uint8_t* data, size_t len, uint8_t* hash);
    
    std::vector<uint8_t> buffer(passlen + saltlen);
    memcpy(buffer.data(), password, passlen);
    memcpy(buffer.data() + passlen, salt, saltlen);
    
    uint8_t hash[32];
    sha256_hash(buffer.data(), buffer.size(), hash);
    
    // Copy to output
    size_t copy_len = (outlen < 32) ? outlen : 32;
    memcpy(out, hash, copy_len);
    
    // Fill remaining with repeated hash
    for (size_t i = copy_len; i < outlen; i++) {
        out[i] = hash[i % 32];
    }
}

// Scrypt hash function
void scrypt_hash(const uint8_t* data, size_t len, uint8_t* hash) {
    // Scrypt parameters for cryptocurrency mining
    const int N = 1024;  // CPU cost parameter
    const int r = 1;     // Memory cost parameter
    const int p = 1;     // Parallelization parameter
    const int dkLen = 32; // Output length
    
    // Use data as both password and salt for mining
    std::vector<uint8_t> B(128 * r * p);
    
    // Generate initial blocks
    pbkdf2_sha256(data, len, data, len, B.data(), B.size());
    
    // Apply ROMix to each block
    for (int i = 0; i < p; i++) {
        scrypt_romix(&B[i * 128 * r], r, N);
    }
    
    // Generate output
    pbkdf2_sha256(data, len, B.data(), B.size(), hash, dkLen);
}