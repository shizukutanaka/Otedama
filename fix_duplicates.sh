#!/bin/bash

# Remove duplicate types in mining package
echo "Removing duplicate CPUDevice from engine.go..."
sed -i '/^type CPUDevice struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/engine.go

echo "Removing duplicate ASICDevice from engine.go..."
sed -i '/^type ASICDevice struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/engine.go

echo "Removing duplicate GPUDevice from engine.go..."
sed -i '/^type GPUDevice struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/engine.go

echo "Removing duplicate Worker from engine_optimized.go..."
sed -i '/^type Worker struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/engine_optimized.go

echo "Removing duplicate Job from engine_optimized.go..."
sed -i '/^type Job struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/engine_optimized.go

echo "Removing duplicate BlockTemplate from merged.go..."
sed -i '/^type BlockTemplate struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/merged.go

echo "Removing duplicate Transaction from mining_job.go..."
sed -i '/^type Transaction struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/mining_job.go

echo "Removing duplicate OptimizationConfig from optimizer.go..."
sed -i '/^type OptimizationConfig struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/optimizer.go

echo "Removing duplicate OptimizationMetrics from optimizer.go..."
sed -i '/^type OptimizationMetrics struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/optimizer.go

echo "Removing duplicate MemoryOptimizer from optimizer.go..."
sed -i '/^type MemoryOptimizer struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/optimizer.go

echo "Done removing duplicates"