#include <napi.h>
#include "mining_core.h"
#include <thread>
#include <chrono>

using namespace otedama;

class NativeMiner : public Napi::ObjectWrap<NativeMiner> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    NativeMiner(const Napi::CallbackInfo& info);
    
private:
    static Napi::FunctionReference constructor;
    
    Napi::Value Initialize(const Napi::CallbackInfo& info);
    Napi::Value StartMining(const Napi::CallbackInfo& info);
    Napi::Value StopMining(const Napi::CallbackInfo& info);
    Napi::Value GetResult(const Napi::CallbackInfo& info);
    Napi::Value GetHashrate(const Napi::CallbackInfo& info);
    Napi::Value GetTotalHashes(const Napi::CallbackInfo& info);
    Napi::Value GetHardwareInfo(const Napi::CallbackInfo& info);
    Napi::Value GetTemperature(const Napi::CallbackInfo& info);
    Napi::Value GetPowerUsage(const Napi::CallbackInfo& info);
    Napi::Value SetAlgorithm(const Napi::CallbackInfo& info);
    Napi::Value SetThreadCount(const Napi::CallbackInfo& info);
    
    std::unique_ptr<MiningCore> core_;
};

Napi::FunctionReference NativeMiner::constructor;

Napi::Object NativeMiner::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);
    
    Napi::Function func = DefineClass(env, "NativeMiner", {
        InstanceMethod("initialize", &NativeMiner::Initialize),
        InstanceMethod("startMining", &NativeMiner::StartMining),
        InstanceMethod("stopMining", &NativeMiner::StopMining),
        InstanceMethod("getResult", &NativeMiner::GetResult),
        InstanceMethod("getHashrate", &NativeMiner::GetHashrate),
        InstanceMethod("getTotalHashes", &NativeMiner::GetTotalHashes),
        InstanceMethod("getHardwareInfo", &NativeMiner::GetHardwareInfo),
        InstanceMethod("getTemperature", &NativeMiner::GetTemperature),
        InstanceMethod("getPowerUsage", &NativeMiner::GetPowerUsage),
        InstanceMethod("setAlgorithm", &NativeMiner::SetAlgorithm),
        InstanceMethod("setThreadCount", &NativeMiner::SetThreadCount),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("NativeMiner", func);
    
    // Export algorithm enum
    Napi::Object algorithms = Napi::Object::New(env);
    algorithms.Set("SHA256", Napi::Number::New(env, static_cast<int>(Algorithm::SHA256)));
    algorithms.Set("SCRYPT", Napi::Number::New(env, static_cast<int>(Algorithm::SCRYPT)));
    algorithms.Set("ETHASH", Napi::Number::New(env, static_cast<int>(Algorithm::ETHASH)));
    algorithms.Set("RANDOMX", Napi::Number::New(env, static_cast<int>(Algorithm::RANDOMX)));
    algorithms.Set("KAWPOW", Napi::Number::New(env, static_cast<int>(Algorithm::KAWPOW)));
    exports.Set("Algorithm", algorithms);
    
    // Export hardware type enum
    Napi::Object hardwareTypes = Napi::Object::New(env);
    hardwareTypes.Set("CPU", Napi::Number::New(env, static_cast<int>(HardwareType::CPU)));
    hardwareTypes.Set("GPU_NVIDIA", Napi::Number::New(env, static_cast<int>(HardwareType::GPU_NVIDIA)));
    hardwareTypes.Set("GPU_AMD", Napi::Number::New(env, static_cast<int>(HardwareType::GPU_AMD)));
    exports.Set("HardwareType", hardwareTypes);
    
    // Export hardware detection function
    exports.Set("detectHardware", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        auto devices = HardwareDetector::detectDevices();
        Napi::Array result = Napi::Array::New(env, devices.size());
        
        for (size_t i = 0; i < devices.size(); i++) {
            Napi::Object device = Napi::Object::New(env);
            device.Set("type", Napi::Number::New(env, static_cast<int>(devices[i].type)));
            device.Set("name", Napi::String::New(env, devices[i].name));
            device.Set("deviceId", Napi::Number::New(env, devices[i].device_id));
            device.Set("memorySize", Napi::Number::New(env, devices[i].memory_size));
            device.Set("computeUnits", Napi::Number::New(env, devices[i].compute_units));
            device.Set("available", Napi::Boolean::New(env, devices[i].available));
            result.Set(i, device);
        }
        
        return result;
    }));
    
    return exports;
}

NativeMiner::NativeMiner(const Napi::CallbackInfo& info) : 
    Napi::ObjectWrap<NativeMiner>(info),
    core_(std::make_unique<MiningCore>()) {
}

Napi::Value NativeMiner::Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Hardware type expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    int hw_type = info[0].As<Napi::Number>().Int32Value();
    int device_id = 0;
    
    if (info.Length() >= 2 && info[1].IsNumber()) {
        device_id = info[1].As<Napi::Number>().Int32Value();
    }
    
    bool success = core_->initialize(static_cast<HardwareType>(hw_type), device_id);
    return Napi::Boolean::New(env, success);
}

Napi::Value NativeMiner::StartMining(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Mining job object expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Object job_obj = info[0].As<Napi::Object>();
    MiningJob job;
    
    if (job_obj.Has("jobId")) {
        job.job_id = job_obj.Get("jobId").As<Napi::String>().Utf8Value();
    }
    
    if (job_obj.Has("blockHeader")) {
        job.block_header = job_obj.Get("blockHeader").As<Napi::String>().Utf8Value();
    }
    
    if (job_obj.Has("target")) {
        job.target = job_obj.Get("target").As<Napi::String>().Utf8Value();
    }
    
    if (job_obj.Has("nonceStart")) {
        job.nonce_start = job_obj.Get("nonceStart").As<Napi::Number>().Int64Value();
    }
    
    if (job_obj.Has("nonceEnd")) {
        job.nonce_end = job_obj.Get("nonceEnd").As<Napi::Number>().Int64Value();
    }
    
    if (job_obj.Has("algorithm")) {
        job.algorithm = static_cast<Algorithm>(job_obj.Get("algorithm").As<Napi::Number>().Int32Value());
    }
    
    bool success = core_->startMining(job);
    return Napi::Boolean::New(env, success);
}

Napi::Value NativeMiner::StopMining(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    core_->stopMining();
    return env.Undefined();
}

Napi::Value NativeMiner::GetResult(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    MiningResult result;
    if (core_->getResult(result)) {
        Napi::Object result_obj = Napi::Object::New(env);
        result_obj.Set("jobId", Napi::String::New(env, result.job_id));
        result_obj.Set("nonce", Napi::Number::New(env, result.nonce));
        result_obj.Set("hash", Napi::String::New(env, result.hash));
        result_obj.Set("valid", Napi::Boolean::New(env, result.valid));
        result_obj.Set("hashrate", Napi::Number::New(env, result.hashrate));
        return result_obj;
    }
    
    return env.Null();
}

Napi::Value NativeMiner::GetHashrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Number::New(env, core_->getCurrentHashrate());
}

Napi::Value NativeMiner::GetTotalHashes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Number::New(env, core_->getTotalHashes());
}

Napi::Value NativeMiner::GetHardwareInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::String::New(env, core_->getHardwareInfo());
}

Napi::Value NativeMiner::GetTemperature(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Number::New(env, core_->getTemperature());
}

Napi::Value NativeMiner::GetPowerUsage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Number::New(env, core_->getPowerUsage());
}

Napi::Value NativeMiner::SetAlgorithm(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Algorithm type expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    int algo = info[0].As<Napi::Number>().Int32Value();
    bool success = core_->setAlgorithm(static_cast<Algorithm>(algo));
    return Napi::Boolean::New(env, success);
}

Napi::Value NativeMiner::SetThreadCount(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Thread count expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    int count = info[0].As<Napi::Number>().Int32Value();
    core_->setThreadCount(count);
    return env.Undefined();
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return NativeMiner::Init(env, exports);
}

NODE_API_MODULE(otedama_native, Init)