#include <napi.h>
#include <cstring>
#include <cstdint>
#include <vector>
#include <thread>
#include <atomic>
#include <chrono>

// Forward declarations
void sha256_hash(const uint8_t* data, size_t len, uint8_t* hash);
void scrypt_hash(const uint8_t* data, size_t len, uint8_t* hash);

class MiningCore : public Napi::ObjectWrap<MiningCore> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    MiningCore(const Napi::CallbackInfo& info);

private:
    static Napi::FunctionReference constructor;
    
    Napi::Value Mine(const Napi::CallbackInfo& info);
    Napi::Value ValidateShare(const Napi::CallbackInfo& info);
    Napi::Value GetHashrate(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    
    std::atomic<bool> mining{false};
    std::atomic<uint64_t> hashCount{0};
    std::atomic<uint64_t> startTime{0};
    std::vector<std::thread> workers;
    
    void MineWorker(const std::vector<uint8_t>& header, uint64_t startNonce, uint64_t endNonce, const std::string& algorithm);
    bool CheckDifficulty(const uint8_t* hash, const uint8_t* target);
};

Napi::FunctionReference MiningCore::constructor;

Napi::Object MiningCore::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);
    
    Napi::Function func = DefineClass(env, "MiningCore", {
        InstanceMethod("mine", &MiningCore::Mine),
        InstanceMethod("validateShare", &MiningCore::ValidateShare),
        InstanceMethod("getHashrate", &MiningCore::GetHashrate),
        InstanceMethod("stop", &MiningCore::Stop)
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("MiningCore", func);
    return exports;
}

MiningCore::MiningCore(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MiningCore>(info) {
    // Constructor
}

Napi::Value MiningCore::Mine(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (!info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsString()) {
        Napi::TypeError::New(env, "Invalid arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Buffer<uint8_t> headerBuf = info[0].As<Napi::Buffer<uint8_t>>();
    uint64_t startNonce = info[1].As<Napi::Number>().Uint32Value();
    uint64_t endNonce = info[2].As<Napi::Number>().Uint32Value();
    std::string algorithm = info[3].As<Napi::String>().Utf8Value();
    
    std::vector<uint8_t> header(headerBuf.Data(), headerBuf.Data() + headerBuf.Length());
    
    // Reset counters
    mining = true;
    hashCount = 0;
    startTime = std::chrono::steady_clock::now().time_since_epoch().count();
    
    // Start mining threads
    unsigned int numThreads = std::thread::hardware_concurrency();
    uint64_t rangePerThread = (endNonce - startNonce) / numThreads;
    
    for (unsigned int i = 0; i < numThreads; i++) {
        uint64_t threadStart = startNonce + (i * rangePerThread);
        uint64_t threadEnd = (i == numThreads - 1) ? endNonce : threadStart + rangePerThread;
        
        workers.emplace_back(&MiningCore::MineWorker, this, header, threadStart, threadEnd, algorithm);
    }
    
    return Napi::Boolean::New(env, true);
}

void MiningCore::MineWorker(const std::vector<uint8_t>& header, uint64_t startNonce, uint64_t endNonce, const std::string& algorithm) {
    std::vector<uint8_t> workHeader = header;
    uint8_t hash[32];
    
    for (uint64_t nonce = startNonce; nonce < endNonce && mining; nonce++) {
        // Update nonce in header (assuming last 4 bytes)
        workHeader[workHeader.size() - 4] = (nonce >> 0) & 0xFF;
        workHeader[workHeader.size() - 3] = (nonce >> 8) & 0xFF;
        workHeader[workHeader.size() - 2] = (nonce >> 16) & 0xFF;
        workHeader[workHeader.size() - 1] = (nonce >> 24) & 0xFF;
        
        // Calculate hash
        if (algorithm == "sha256") {
            sha256_hash(workHeader.data(), workHeader.size(), hash);
        } else if (algorithm == "scrypt") {
            scrypt_hash(workHeader.data(), workHeader.size(), hash);
        }
        
        hashCount++;
    }
}

Napi::Value MiningCore::ValidateShare(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsBuffer()) {
        Napi::TypeError::New(env, "Invalid arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Buffer<uint8_t> hashBuf = info[0].As<Napi::Buffer<uint8_t>>();
    Napi::Buffer<uint8_t> targetBuf = info[1].As<Napi::Buffer<uint8_t>>();
    
    bool valid = CheckDifficulty(hashBuf.Data(), targetBuf.Data());
    
    return Napi::Boolean::New(env, valid);
}

bool MiningCore::CheckDifficulty(const uint8_t* hash, const uint8_t* target) {
    for (int i = 31; i >= 0; i--) {
        if (hash[i] > target[i]) return false;
        if (hash[i] < target[i]) return true;
    }
    return true;
}

Napi::Value MiningCore::GetHashrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    uint64_t currentTime = std::chrono::steady_clock::now().time_since_epoch().count();
    double elapsedSeconds = (currentTime - startTime) / 1e9;
    
    if (elapsedSeconds > 0) {
        double hashrate = hashCount / elapsedSeconds;
        return Napi::Number::New(env, hashrate);
    }
    
    return Napi::Number::New(env, 0);
}

Napi::Value MiningCore::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    mining = false;
    
    // Wait for all workers to finish
    for (auto& worker : workers) {
        if (worker.joinable()) {
            worker.join();
        }
    }
    workers.clear();
    
    return Napi::Boolean::New(env, true);
}

// Module initialization
Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return MiningCore::Init(env, exports);
}

NODE_API_MODULE(otedama_native, InitAll)