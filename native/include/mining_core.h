#ifndef OTEDAMA_MINING_CORE_H
#define OTEDAMA_MINING_CORE_H

#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <thread>

namespace otedama {

// Forward declarations
class HashAlgorithm;
class MiningJob;
class MiningResult;

// Supported mining algorithms
enum class Algorithm {
    SHA256,
    SCRYPT,
    ETHASH,
    RANDOMX,
    KAWPOW,
    EQUIHASH,
    X11,
    BLAKE2B,
    CRYPTONIGHT
};

// Hardware types
enum class HardwareType {
    CPU,
    GPU_NVIDIA,
    GPU_AMD,
    GPU_INTEL,
    ASIC,
    FPGA
};

// Mining job structure
class MiningJob {
public:
    std::string job_id;
    std::string block_header;
    std::string target;
    uint64_t nonce_start;
    uint64_t nonce_end;
    Algorithm algorithm;
    
    MiningJob() : nonce_start(0), nonce_end(0), algorithm(Algorithm::SHA256) {}
};

// Mining result structure
class MiningResult {
public:
    std::string job_id;
    uint64_t nonce;
    std::string hash;
    bool valid;
    double hashrate;
    
    MiningResult() : nonce(0), valid(false), hashrate(0.0) {}
};

// Base class for hash algorithms
class HashAlgorithm {
public:
    virtual ~HashAlgorithm() = default;
    virtual std::string compute(const std::string& data) = 0;
    virtual bool verify(const std::string& hash, const std::string& target) = 0;
    virtual size_t getMemoryRequirement() const { return 0; }
};

// Main mining core class
class MiningCore {
public:
    MiningCore();
    ~MiningCore();
    
    // Initialize with specific hardware
    bool initialize(HardwareType hardware, int device_id = 0);
    
    // Start/stop mining
    bool startMining(const MiningJob& job);
    void stopMining();
    
    // Get mining results
    bool getResult(MiningResult& result);
    
    // Performance metrics
    double getCurrentHashrate() const;
    double getAverageHashrate() const;
    uint64_t getTotalHashes() const;
    
    // Hardware info
    std::string getHardwareInfo() const;
    int getTemperature() const;
    int getPowerUsage() const;
    
    // Algorithm management
    bool setAlgorithm(Algorithm algo);
    Algorithm getCurrentAlgorithm() const;
    
    // Thread management
    void setThreadCount(int count);
    int getThreadCount() const;
    
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

// Hardware detection utilities
class HardwareDetector {
public:
    struct DeviceInfo {
        HardwareType type;
        std::string name;
        int device_id;
        size_t memory_size;
        int compute_units;
        bool available;
    };
    
    static std::vector<DeviceInfo> detectDevices();
    static DeviceInfo getCPUInfo();
    static std::vector<DeviceInfo> getGPUInfo();
};

// Optimized hash implementations
namespace algorithms {
    std::unique_ptr<HashAlgorithm> createSHA256();
    std::unique_ptr<HashAlgorithm> createScrypt(int n = 1024, int r = 1, int p = 1);
    std::unique_ptr<HashAlgorithm> createEthash();
    std::unique_ptr<HashAlgorithm> createRandomX();
    std::unique_ptr<HashAlgorithm> createKawPow();
}

} // namespace otedama

#endif // OTEDAMA_MINING_CORE_H