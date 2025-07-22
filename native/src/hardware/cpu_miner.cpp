#include "mining_core.h"
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <intrin.h>
#elif __linux__
#include <unistd.h>
#include <sys/sysinfo.h>
#elif __APPLE__
#include <sys/types.h>
#include <sys/sysctl.h>
#endif

namespace otedama {

// CPU information and optimization
class CPUInfo {
public:
    static int getCoreCount() {
        return std::thread::hardware_concurrency();
    }
    
    static std::string getCPUBrand() {
        #ifdef _WIN32
        int cpuInfo[4] = {0};
        char brand[49] = {0};
        
        __cpuid(cpuInfo, 0x80000002);
        memcpy(brand, cpuInfo, sizeof(cpuInfo));
        __cpuid(cpuInfo, 0x80000003);
        memcpy(brand + 16, cpuInfo, sizeof(cpuInfo));
        __cpuid(cpuInfo, 0x80000004);
        memcpy(brand + 32, cpuInfo, sizeof(cpuInfo));
        
        return std::string(brand);
        #else
        return "Generic CPU";
        #endif
    }
    
    static bool hasAVX2() {
        #ifdef _WIN32
        int cpuInfo[4];
        __cpuid(cpuInfo, 7);
        return (cpuInfo[1] & (1 << 5)) != 0;
        #else
        return false; // Simplified
        #endif
    }
    
    static bool hasSSE4() {
        #ifdef _WIN32
        int cpuInfo[4];
        __cpuid(cpuInfo, 1);
        return (cpuInfo[2] & (1 << 19)) != 0;
        #else
        return false; // Simplified
        #endif
    }
};

// CPU Miner implementation
class CPUMiner {
private:
    int thread_count_;
    bool has_avx2_;
    bool has_sse4_;
    
public:
    CPUMiner() : 
        thread_count_(CPUInfo::getCoreCount()),
        has_avx2_(CPUInfo::hasAVX2()),
        has_sse4_(CPUInfo::hasSSE4()) {}
    
    std::string getInfo() const {
        std::string info = "CPU: " + CPUInfo::getCPUBrand();
        info += " (" + std::to_string(thread_count_) + " cores)";
        if (has_avx2_) info += " AVX2";
        if (has_sse4_) info += " SSE4";
        return info;
    }
    
    int getOptimalThreadCount() const {
        // Leave one core for system
        return std::max(1, thread_count_ - 1);
    }
    
    void setThreadAffinity(std::thread& t, int core_id) {
        #ifdef __linux__
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(core_id, &cpuset);
        pthread_setaffinity_np(t.native_handle(), sizeof(cpu_set_t), &cpuset);
        #endif
    }
};

} // namespace otedama