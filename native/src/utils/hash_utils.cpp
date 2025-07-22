#include <string>
#include <vector>
#include <sstream>
#include <iomanip>

namespace otedama {
namespace utils {

// Utility functions for hash operations
std::string bytesToHex(const std::vector<uint8_t>& bytes) {
    std::stringstream ss;
    for (uint8_t byte : bytes) {
        ss << std::hex << std::setfill('0') << std::setw(2) << (int)byte;
    }
    return ss.str();
}

std::vector<uint8_t> hexToBytes(const std::string& hex) {
    std::vector<uint8_t> bytes;
    for (size_t i = 0; i < hex.length(); i += 2) {
        uint8_t byte = std::stoi(hex.substr(i, 2), nullptr, 16);
        bytes.push_back(byte);
    }
    return bytes;
}

bool compareTarget(const std::string& hash, const std::string& target) {
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

uint32_t swapEndian32(uint32_t val) {
    return ((val & 0xFF000000) >> 24) |
           ((val & 0x00FF0000) >> 8) |
           ((val & 0x0000FF00) << 8) |
           ((val & 0x000000FF) << 24);
}

uint64_t swapEndian64(uint64_t val) {
    return ((val & 0xFF00000000000000ULL) >> 56) |
           ((val & 0x00FF000000000000ULL) >> 40) |
           ((val & 0x0000FF0000000000ULL) >> 24) |
           ((val & 0x000000FF00000000ULL) >> 8) |
           ((val & 0x00000000FF000000ULL) << 8) |
           ((val & 0x0000000000FF0000ULL) << 24) |
           ((val & 0x000000000000FF00ULL) << 40) |
           ((val & 0x00000000000000FFULL) << 56);
}

} // namespace utils
} // namespace otedama