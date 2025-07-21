/**
 * Mining Constants
 * Centralized location for all mining-related constants
 */

// Supported mining algorithms
export const ALGORITHMS = {
    SHA256: 'sha256',
    SCRYPT: 'scrypt',
    ETHASH: 'ethash',
    RANDOMX: 'randomx',
    KAWPOW: 'kawpow',
    X11: 'x11',
    EQUIHASH: 'equihash',
    AUTOLYKOS: 'autolykos2',
    KHEAVYHASH: 'kheavyhash',
    BLAKE3: 'blake3'
};

// Algorithm to currency mapping
export const ALGO_CURRENCY_MAP = {
    [ALGORITHMS.SHA256]: ['BTC', 'BCH', 'BSV'],
    [ALGORITHMS.SCRYPT]: ['LTC', 'DOGE'],
    [ALGORITHMS.ETHASH]: ['ETH', 'ETC'],
    [ALGORITHMS.RANDOMX]: ['XMR'],
    [ALGORITHMS.KAWPOW]: ['RVN'],
    [ALGORITHMS.X11]: ['DASH'],
    [ALGORITHMS.EQUIHASH]: ['ZEC', 'FLUX', 'ZEN'],
    [ALGORITHMS.AUTOLYKOS]: ['ERGO'],
    [ALGORITHMS.KHEAVYHASH]: ['KAS'],
    [ALGORITHMS.BLAKE3]: ['ALPH']
};

// Mining difficulty targets
export const DIFFICULTY_TARGETS = {
    [ALGORITHMS.SHA256]: 0x1d00ffff,
    [ALGORITHMS.SCRYPT]: 0x1e0ffff0,
    [ALGORITHMS.ETHASH]: 0x00000000ffff0000,
    [ALGORITHMS.RANDOMX]: 0x00000000ffffffff,
    [ALGORITHMS.KAWPOW]: 0x00000000ff000000,
    [ALGORITHMS.X11]: 0x1e0fffff,
    [ALGORITHMS.EQUIHASH]: 0x1f07ffff,
    [ALGORITHMS.AUTOLYKOS]: 0x1b0404cb,
    [ALGORITHMS.KHEAVYHASH]: 0x1e00ffff,
    [ALGORITHMS.BLAKE3]: 0x1d00ffff
};

// Share difficulty multipliers
export const SHARE_DIFFICULTY_MULTIPLIERS = {
    [ALGORITHMS.SHA256]: 65536,
    [ALGORITHMS.SCRYPT]: 65536,
    [ALGORITHMS.ETHASH]: 4294967296,
    [ALGORITHMS.RANDOMX]: 256,
    [ALGORITHMS.KAWPOW]: 4096,
    [ALGORITHMS.X11]: 256,
    [ALGORITHMS.EQUIHASH]: 131072,
    [ALGORITHMS.AUTOLYKOS]: 4096,
    [ALGORITHMS.KHEAVYHASH]: 65536,
    [ALGORITHMS.BLAKE3]: 256
};

// Block time targets (seconds)
export const BLOCK_TIME_TARGETS = {
    BTC: 600,      // 10 minutes
    LTC: 150,      // 2.5 minutes
    ETH: 13,       // 13 seconds
    XMR: 120,      // 2 minutes
    DOGE: 60,      // 1 minute
    DASH: 150,     // 2.5 minutes
    ZEC: 75,       // 1.25 minutes
    RVN: 60,       // 1 minute
    ERGO: 120,     // 2 minutes
    KAS: 1,        // 1 second
    ALPH: 64       // 64 seconds
};

// Network difficulty adjustment intervals (blocks)
export const DIFFICULTY_ADJUSTMENT_INTERVALS = {
    BTC: 2016,     // ~2 weeks
    LTC: 2016,     // ~3.5 days
    ETH: 1,        // Every block
    XMR: 1,        // Every block
    DOGE: 240,     // ~4 hours
    DASH: 1,       // Every block (DGW)
    ZEC: 1,        // Every block
    RVN: 2016,     // ~1 day
    ERGO: 1,       // Every block
    KAS: 1,        // Every block (DAA)
    ALPH: 1        // Every block
};

// Stratum error codes
export const STRATUM_ERRORS = {
    UNAUTHORIZED: [-1, 'Unauthorized', null],
    NOT_SUBSCRIBED: [-2, 'Not subscribed', null],
    NOT_AUTHORIZED: [-3, 'Not authorized', null],
    UNKNOWN_METHOD: [-3, 'Unknown method', null],
    INVALID_PARAMS: [-20, 'Invalid params', null],
    INTERNAL_ERROR: [-20, 'Internal error', null],
    LOW_DIFFICULTY: [-23, 'Low difficulty share', null],
    DUPLICATE_SHARE: [-22, 'Duplicate share', null],
    JOB_NOT_FOUND: [-21, 'Job not found', null],
    STALE_SHARE: [-21, 'Stale share', null]
};

// Pool fee structures
export const FEE_STRUCTURES = {
    DIRECT: {
        baseFee: 0.018,    // 1.8%
        description: 'Direct payout in mined currency'
    },
    CONVERT: {
        poolFee: 0.018,    // 1.8%
        conversionFee: 0.002, // 0.2%
        totalFee: 0.02,    // 2.0%
        description: 'Convert to BTC payout'
    }
};

// Mining hardware types
export const HARDWARE_TYPES = {
    ASIC: 'asic',
    GPU: 'gpu',
    CPU: 'cpu',
    FPGA: 'fpga'
};

// Common mining software user agents
export const MINING_SOFTWARE = {
    CGMINER: /cgminer/i,
    BFGMINER: /bfgminer/i,
    CCMINER: /ccminer/i,
    CLAYMORE: /claymore/i,
    PHOENIXMINER: /phoenix/i,
    TEAMREDMINER: /teamred/i,
    TREX: /t-rex/i,
    GMINER: /gminer/i,
    LOLMINER: /lolminer/i,
    XMRIG: /xmrig/i,
    CPUMINER: /cpuminer/i,
    MINIRIG: /minirig/i,
    NBMINER: /nbminer/i,
    KAWPOWMINER: /kawpowminer/i
};

// Export all constants
export default {
    ALGORITHMS,
    ALGO_CURRENCY_MAP,
    DIFFICULTY_TARGETS,
    SHARE_DIFFICULTY_MULTIPLIERS,
    BLOCK_TIME_TARGETS,
    DIFFICULTY_ADJUSTMENT_INTERVALS,
    STRATUM_ERRORS,
    FEE_STRUCTURES,
    HARDWARE_TYPES,
    MINING_SOFTWARE
};