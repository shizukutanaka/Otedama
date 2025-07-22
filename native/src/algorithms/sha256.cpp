#include "mining_core.h"
#include <cstring>
#include <sstream>
#include <iomanip>

#ifdef _WIN32
#include <intrin.h>
#else
#include <x86intrin.h>
#endif

namespace otedama {
namespace algorithms {

// SHA256 constants
static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

// Optimized SHA256 implementation
class SHA256Algorithm : public HashAlgorithm {
private:
    static inline uint32_t Ch(uint32_t x, uint32_t y, uint32_t z) {
        return (x & y) ^ (~x & z);
    }
    
    static inline uint32_t Maj(uint32_t x, uint32_t y, uint32_t z) {
        return (x & y) ^ (x & z) ^ (y & z);
    }
    
    static inline uint32_t ROTR(uint32_t x, int n) {
        return (x >> n) | (x << (32 - n));
    }
    
    static inline uint32_t Sigma0(uint32_t x) {
        return ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22);
    }
    
    static inline uint32_t Sigma1(uint32_t x) {
        return ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25);
    }
    
    static inline uint32_t sigma0(uint32_t x) {
        return ROTR(x, 7) ^ ROTR(x, 18) ^ (x >> 3);
    }
    
    static inline uint32_t sigma1(uint32_t x) {
        return ROTR(x, 17) ^ ROTR(x, 19) ^ (x >> 10);
    }
    
    void transform(uint32_t state[8], const uint8_t block[64]) {
        uint32_t W[64];
        uint32_t a, b, c, d, e, f, g, h;
        
        // Prepare message schedule
        for (int i = 0; i < 16; i++) {
            W[i] = (block[i * 4] << 24) |
                   (block[i * 4 + 1] << 16) |
                   (block[i * 4 + 2] << 8) |
                   (block[i * 4 + 3]);
        }
        
        // SIMD optimization for message expansion (if available)
        #ifdef __AVX2__
        for (int i = 16; i < 64; i += 8) {
            __m256i w0 = _mm256_loadu_si256((__m256i*)&W[i - 16]);
            __m256i w1 = _mm256_loadu_si256((__m256i*)&W[i - 7]);
            // Simplified - real implementation would use proper SIMD operations
            for (int j = 0; j < 8 && i + j < 64; j++) {
                W[i + j] = sigma1(W[i + j - 2]) + W[i + j - 7] +
                          sigma0(W[i + j - 15]) + W[i + j - 16];
            }
        }
        #else
        for (int i = 16; i < 64; i++) {
            W[i] = sigma1(W[i - 2]) + W[i - 7] +
                   sigma0(W[i - 15]) + W[i - 16];
        }
        #endif
        
        // Initialize working variables
        a = state[0];
        b = state[1];
        c = state[2];
        d = state[3];
        e = state[4];
        f = state[5];
        g = state[6];
        h = state[7];
        
        // Main loop
        for (int i = 0; i < 64; i++) {
            uint32_t T1 = h + Sigma1(e) + Ch(e, f, g) + K[i] + W[i];
            uint32_t T2 = Sigma0(a) + Maj(a, b, c);
            h = g;
            g = f;
            f = e;
            e = d + T1;
            d = c;
            c = b;
            b = a;
            a = T1 + T2;
        }
        
        // Add compressed chunk to current hash value
        state[0] += a;
        state[1] += b;
        state[2] += c;
        state[3] += d;
        state[4] += e;
        state[5] += f;
        state[6] += g;
        state[7] += h;
    }
    
public:
    std::string compute(const std::string& data) override {
        uint32_t state[8] = {
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        };
        
        // Prepare message
        size_t len = data.length();
        size_t total_len = len + 1 + 8; // data + 0x80 + length
        size_t block_count = (total_len + 63) / 64;
        
        std::vector<uint8_t> padded(block_count * 64, 0);
        std::memcpy(padded.data(), data.data(), len);
        padded[len] = 0x80;
        
        // Append length in bits
        uint64_t bit_len = len * 8;
        for (int i = 0; i < 8; i++) {
            padded[padded.size() - 1 - i] = (bit_len >> (i * 8)) & 0xff;
        }
        
        // Process blocks
        for (size_t i = 0; i < block_count; i++) {
            transform(state, &padded[i * 64]);
        }
        
        // Convert to hex string
        std::stringstream ss;
        for (int i = 0; i < 8; i++) {
            ss << std::hex << std::setfill('0') << std::setw(8) << state[i];
        }
        
        return ss.str();
    }
    
    bool verify(const std::string& hash, const std::string& target) override {
        // Compare as big-endian numbers
        if (hash.length() != target.length()) {
            return false;
        }
        
        for (size_t i = 0; i < hash.length(); i++) {
            if (hash[i] < target[i]) return true;
            if (hash[i] > target[i]) return false;
        }
        
        return true; // Equal to target
    }
};

// Double SHA256 for Bitcoin
class DoubleSHA256Algorithm : public HashAlgorithm {
private:
    SHA256Algorithm sha256;
    
public:
    std::string compute(const std::string& data) override {
        std::string first_hash = sha256.compute(data);
        // Convert hex string back to binary for second hash
        std::string binary;
        for (size_t i = 0; i < first_hash.length(); i += 2) {
            uint8_t byte = std::stoi(first_hash.substr(i, 2), nullptr, 16);
            binary.push_back(byte);
        }
        return sha256.compute(binary);
    }
    
    bool verify(const std::string& hash, const std::string& target) override {
        return sha256.verify(hash, target);
    }
};

std::unique_ptr<HashAlgorithm> createSHA256() {
    return std::make_unique<DoubleSHA256Algorithm>();
}

} // namespace algorithms
} // namespace otedama