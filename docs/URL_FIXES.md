# URL Fixes Summary

## Fixed Non-Existent URLs

### 1. README.md
- **GitHub Release URLs**: Changed from specific username to placeholder `yourusername`
  - `https://github.com/shizukutanaka/Otedama/releases/` → Comments indicating to replace with actual username
- **Repository URL**: 
  - `https://github.com/shizukutanaka/Otedama.git` → `https://github.com/yourusername/otedama.git`
- **Wiki URLs**: Replaced with local documentation references
  - Wiki links → References to `/docs` directory
- **Example domains**:
  - `pool.example.com` → `your-pool-address`
  - `peer1.example.com`, `peer2.example.com` → `192.168.1.100`, `192.168.1.101`

### 2. docs/SOLO_P2P_MINING.md
- **GitHub URLs**: Updated to use placeholder username
  - `https://github.com/username/Otedama/` → `https://github.com/yourusername/otedama/`
- **Wiki URL**: Replaced with local documentation reference

### 3. Configuration Files
- **config.yaml**: 
  - `stratum+tcp://pool.example.com:3333` → `stratum+tcp://your-pool-address:3333`
- **config.sample.yaml**: 
  - Same pool URL update
- **config.solo.yaml**:
  - `peer1.otedama.network`, `peer2.otedama.network` → Example local IPs with comments
  - `backup1.example.com`, `backup2.example.com` → Example local IPs with comments

### 4. Source Code
- **internal/solomining/hybrid_pool.go**:
  - `seed1.otedama.io`, `seed2.otedama.io`, `seed3.otedama.io` → Commented out with example local IPs
- **cmd/otedama/commands/root.go**:
  - `https://github.com/shizukutanaka/Otedama` → `https://github.com/yourusername/otedama`
- **cmd/otedama/commands/p2p.go**:
  - `peer1.example.com:3333`, `peer2.example.com:3333` → `192.168.1.100:3333`, `192.168.1.101:3333`
- **cmd/otedama/commands/pool.go**:
  - `stratum+tcp://pool.example.com:3333` → `stratum+tcp://your-pool-address:3333`

## URL Patterns Used

### For Documentation
- GitHub repository: `https://github.com/yourusername/otedama`
- Local documentation: References to `/docs` directory

### For Examples
- Pool addresses: `your-pool-address` (with comments to replace)
- Peer addresses: Local IP examples like `192.168.1.100:port`
- Seed nodes: Commented out with example local IPs

### Valid URLs Kept
- `http://localhost:8080` - For local web dashboard
- `http://localhost:8332` - For local node RPC
- `http://localhost:9090/metrics` - For Prometheus metrics

## Rationale
- Removed hardcoded domains that don't exist
- Used placeholders that clearly indicate replacement is needed
- Used local IP addresses for examples instead of non-existent domains
- Added comments where appropriate to guide users
- Kept localhost URLs as they are valid for local services