#!/bin/bash

echo "Verifying fixes applied to Otedama project..."
echo "============================================="

# Check memory_pool.go for Buffer type conflicts
echo "1. Checking memory_pool.go for type conflicts..."
if grep -q "type Buffer struct" internal/optimization/memory_pool.go; then
    echo "   ERROR: Buffer type still exists (should be SimpleBuffer)"
else
    echo "   ✓ Buffer renamed to SimpleBuffer"
fi

# Check for SimpleMemoryPool methods
echo "2. Checking SimpleMemoryPool methods..."
if grep -q "func (mp \*SimpleMemoryPool) Get" internal/optimization/memory_pool.go && \
   grep -q "func (mp \*SimpleMemoryPool) Put" internal/optimization/memory_pool.go; then
    echo "   ✓ SimpleMemoryPool has Get/Put methods"
else
    echo "   ERROR: SimpleMemoryPool missing Get/Put methods"
fi

# Check for unused imports
echo "3. Checking for removed unused imports..."
errors=0

if grep -q "^[[:space:]]*\"runtime\"" internal/mining/algorithms/asic_resistant.go; then
    echo "   ERROR: runtime still imported in asic_resistant.go"
    errors=$((errors+1))
else
    echo "   ✓ runtime removed from asic_resistant.go"
fi

if grep -q "^[[:space:]]*\"crypto/rand\"" internal/mining/algorithms/cpu_optimized.go; then
    echo "   ERROR: crypto/rand still imported in cpu_optimized.go"
    errors=$((errors+1))
else
    echo "   ✓ crypto/rand removed from cpu_optimized.go"
fi

if grep -q "^[[:space:]]*\"math\"" internal/mining/algorithms/cpu_optimized.go; then
    echo "   ERROR: math still imported in cpu_optimized.go"
    errors=$((errors+1))
else
    echo "   ✓ math removed from cpu_optimized.go"
fi

if grep -q "^[[:space:]]*\"fmt\"" internal/mining/algorithms/ethash_impl.go; then
    echo "   ERROR: fmt still imported in ethash_impl.go"
    errors=$((errors+1))
else
    echo "   ✓ fmt removed from ethash_impl.go"
fi

if grep -q "^[[:space:]]*\"runtime\"" internal/mining/algorithms/gpu_optimized.go; then
    echo "   ERROR: runtime still imported in gpu_optimized.go"
    errors=$((errors+1))
else
    echo "   ✓ runtime removed from gpu_optimized.go"
fi

if grep -q "^[[:space:]]*\"unsafe\"" internal/mining/algorithms/gpu_optimized.go; then
    echo "   ERROR: unsafe still imported in gpu_optimized.go"
    errors=$((errors+1))
else
    echo "   ✓ unsafe removed from gpu_optimized.go"
fi

if grep -q "^[[:space:]]*\"unsafe\"" internal/mining/algorithms/memory_hard.go; then
    echo "   ERROR: unsafe still imported in memory_hard.go"
    errors=$((errors+1))
else
    echo "   ✓ unsafe removed from memory_hard.go"
fi

if grep -q "^[[:space:]]*\"hash\"" internal/mining/algorithms/x_series.go; then
    echo "   ERROR: hash still imported in x_series.go"
    errors=$((errors+1))
else
    echo "   ✓ hash removed from x_series.go"
fi

echo "============================================="
if [ $errors -eq 0 ]; then
    echo "✓ All fixes successfully applied!"
else
    echo "✗ Found $errors remaining issues"
fi