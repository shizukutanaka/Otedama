#!/bin/bash

echo "Removing more duplicate types..."

# Remove AlgorithmInfo from profit_switcher.go
sed -i '/^type AlgorithmInfo struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/profit_switcher.go

# Remove MiningJob from types.go
sed -i '/^type MiningJob struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/types.go

# Remove Share from types.go
sed -i '/^type Share struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/types.go

# Remove Worker, Job, Share from workers.go
sed -i '/^type Worker struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/workers.go
sed -i '/^type Job struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/workers.go
sed -i '/^type Share struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/mining/workers.go

echo "Done removing duplicates"