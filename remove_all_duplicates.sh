#!/bin/bash

# Remove all duplicate types from security_improvements.go
echo "Removing duplicate types from security_improvements.go"
sed -i '/^type StaticAnalyzer struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type DynamicAnalyzer struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type ReviewRule struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type Trigger struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type TestSuite struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type TestResult struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type TestReporter interface {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type MetricCollector struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type Metric struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go
sed -i '/^type Evidence struct {$/,/^}$/d' /mnt/c/Users/irosa/Desktop/Otedama/internal/improvements/security_improvements.go

echo "Done removing duplicates"