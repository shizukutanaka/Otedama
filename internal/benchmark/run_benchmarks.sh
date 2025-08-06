#!/bin/bash
# Benchmark runner script for Otedama

echo "Running Otedama Performance Benchmarks"
echo "====================================="

# Configuration
BENCH_TIME=10s
BENCH_COUNT=3
OUTPUT_DIR="benchmark_results"

# Create output directory
mkdir -p $OUTPUT_DIR

# Timestamp for results
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Function to run benchmark and save results
run_benchmark() {
    local name=$1
    local pattern=$2
    local output_file="$OUTPUT_DIR/${name}_${TIMESTAMP}.txt"
    
    echo -e "\nRunning $name benchmarks..."
    go test -bench="$pattern" -benchtime=$BENCH_TIME -count=$BENCH_COUNT -benchmem ./internal/benchmark | tee "$output_file"
    
    # Extract and display key metrics
    echo -e "\nKey metrics for $name:"
    grep -E "Benchmark|ns/op|B/op|allocs/op" "$output_file" | tail -20
}

# Run different benchmark categories
echo "Starting benchmark suite..."

# Mining benchmarks
run_benchmark "mining" "BenchmarkSHA256|BenchmarkMiningEngine|BenchmarkHardwareAccelerated"

# Memory benchmarks
run_benchmark "memory" "BenchmarkMemoryPool|BenchmarkMiningMemory"

# Network benchmarks
run_benchmark "network" "BenchmarkConnectionPool|BenchmarkP2PPool|BenchmarkStratumV2"

# Job queue benchmarks
run_benchmark "jobqueue" "BenchmarkJobQueue"

# Difficulty adjustment benchmarks
run_benchmark "difficulty" "BenchmarkDifficultyAdjustment"

# Full system benchmarks
run_benchmark "system" "BenchmarkConcurrentMining|BenchmarkEndToEnd"

# Generate comparison report
echo -e "\nGenerating benchmark comparison report..."
REPORT_FILE="$OUTPUT_DIR/benchmark_report_${TIMESTAMP}.md"

cat > "$REPORT_FILE" << EOF
# Otedama Benchmark Report
Generated: $(date)

## System Information
- OS: $(uname -s)
- Architecture: $(uname -m)
- CPU: $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Unknown")
- CPU Cores: $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "Unknown")
- Go Version: $(go version)

## Benchmark Results

### Mining Performance
EOF

# Extract key mining metrics
grep -A5 "BenchmarkSHA256" "$OUTPUT_DIR/mining_${TIMESTAMP}.txt" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -A5 "BenchmarkHardwareAccelerated" "$OUTPUT_DIR/mining_${TIMESTAMP}.txt" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << EOF

### Memory Performance
EOF

grep -A5 "BenchmarkMemoryPool" "$OUTPUT_DIR/memory_${TIMESTAMP}.txt" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << EOF

### Network Performance
EOF

grep -A5 "BenchmarkConnectionPool" "$OUTPUT_DIR/network_${TIMESTAMP}.txt" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << EOF

### System Throughput
EOF

grep -A5 "BenchmarkConcurrentMining" "$OUTPUT_DIR/system_${TIMESTAMP}.txt" >> "$REPORT_FILE"

echo -e "\nBenchmark report saved to: $REPORT_FILE"

# CPU profiling (optional)
if [ "$1" == "--profile" ]; then
    echo -e "\nRunning CPU profiling..."
    PROFILE_DIR="$OUTPUT_DIR/profiles"
    mkdir -p "$PROFILE_DIR"
    
    go test -bench=BenchmarkEndToEndMining -benchtime=30s -cpuprofile="$PROFILE_DIR/cpu_${TIMESTAMP}.prof" ./internal/benchmark
    go test -bench=BenchmarkEndToEndMining -benchtime=30s -memprofile="$PROFILE_DIR/mem_${TIMESTAMP}.prof" ./internal/benchmark
    
    echo "Profile files saved to: $PROFILE_DIR"
    echo "View with: go tool pprof $PROFILE_DIR/cpu_${TIMESTAMP}.prof"
fi

echo -e "\nBenchmark suite completed!"
echo "Results saved in: $OUTPUT_DIR"