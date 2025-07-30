# Test Specialist Agent

自動テスト作成・実施・ソース修正を行う実用的なテストエージェント。

## Core Functions

### 1. Test Generation
```go
// TestGenerator - 基本的なテスト生成
type TestGenerator struct {
    targetFile string
    testType   string
}

func (tg *TestGenerator) GenerateUnitTest(funcName string) string {
    return fmt.Sprintf(`
func Test%s(t *testing.T) {
    // Arrange
    
    // Act
    result := %s()
    
    // Assert
    if result == nil {
        t.Error("Expected non-nil result")
    }
}`, funcName, funcName)
}

func (tg *TestGenerator) GenerateTableTest(funcName string, cases []TestCase) string {
    template := `
func Test%s(t *testing.T) {
    tests := []struct {
        name     string
        input    interface{}
        expected interface{}
    }{
%s
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := %s(tt.input)
            if result != tt.expected {
                t.Errorf("got %%v, expected %%v", result, tt.expected)
            }
        })
    }
}`
    return fmt.Sprintf(template, funcName, generateTestCases(cases), funcName)
}
```

### 2. Test Execution
```go
// TestRunner - テスト実行
type TestRunner struct {
    timeout time.Duration
    parallel bool
}

func (tr *TestRunner) RunTests(pattern string) *TestResult {
    cmd := exec.Command("go", "test", "-v", pattern)
    if tr.parallel {
        cmd.Args = append(cmd.Args, "-parallel", "4")
    }
    
    output, err := cmd.CombinedOutput()
    return &TestResult{
        Output: string(output),
        Error:  err,
        Passed: err == nil,
    }
}

func (tr *TestRunner) RunWithCoverage(pattern string) *CoverageResult {
    cmd := exec.Command("go", "test", "-cover", "-coverprofile=coverage.out", pattern)
    output, err := cmd.CombinedOutput()
    
    coverage := parseCoverage(string(output))
    return &CoverageResult{
        Percentage: coverage,
        Output:     string(output),
        Error:      err,
    }
}
```

### 3. Source Analysis & Fix
```go
// SourceAnalyzer - ソース分析と修正提案
type SourceAnalyzer struct {
    filePath string
}

func (sa *SourceAnalyzer) AnalyzeTestFailures(testOutput string) []Fix {
    fixes := []Fix{}
    
    // パニック検出
    if strings.Contains(testOutput, "panic:") {
        fixes = append(fixes, Fix{
            Type:        "panic",
            Description: "Add nil check before operation",
            Line:        extractPanicLine(testOutput),
        })
    }
    
    // タイムアウト検出
    if strings.Contains(testOutput, "timeout") {
        fixes = append(fixes, Fix{
            Type:        "timeout",
            Description: "Increase timeout or optimize operation",
            Suggestion:  "context.WithTimeout(ctx, 10*time.Second)",
        })
    }
    
    return fixes
}

func (sa *SourceAnalyzer) ApplyFix(fix Fix) error {
    content, err := ioutil.ReadFile(sa.filePath)
    if err != nil {
        return err
    }
    
    lines := strings.Split(string(content), "\n")
    if fix.Line > 0 && fix.Line <= len(lines) {
        lines[fix.Line-1] = fix.Suggestion
    }
    
    return ioutil.WriteFile(sa.filePath, []byte(strings.Join(lines, "\n")), 0644)
}
```

### 4. Coverage Analysis
```go
// CoverageAnalyzer - カバレッジ分析
type CoverageAnalyzer struct{}

func (ca *CoverageAnalyzer) AnalyzeCoverage(profilePath string) *CoverageReport {
    profiles, err := cover.ParseProfiles(profilePath)
    if err != nil {
        return &CoverageReport{Error: err}
    }
    
    report := &CoverageReport{
        Files: make(map[string]*FileCoverage),
    }
    
    for _, profile := range profiles {
        total := 0
        covered := 0
        
        for _, block := range profile.Blocks {
            total += block.NumStmt
            if block.Count > 0 {
                covered += block.NumStmt
            }
        }
        
        report.Files[profile.FileName] = &FileCoverage{
            Total:      total,
            Covered:    covered,
            Percentage: float64(covered) / float64(total) * 100,
        }
    }
    
    return report
}
```

## Usage Examples

### Basic Test Generation
```bash
# 単一ファイルのテスト生成
go run test-specialist.go generate --file=internal/mining/engine.go

# 複数ファイルのテスト生成
go run test-specialist.go generate --dir=internal/mining/
```

### Test Execution
```bash
# 全テスト実行
go run test-specialist.go run --all

# カバレッジ付き実行
go run test-specialist.go run --coverage --threshold=80

# 特定パッケージ実行
go run test-specialist.go run --package=./internal/mining/...
```

### Fix Application
```bash
# テスト失敗の自動修正
go run test-specialist.go fix --test-output=test_result.txt

# カバレッジ改善提案
go run test-specialist.go suggest --coverage=coverage.out
```

## Configuration
```yaml
# test-config.yaml
generator:
  template: "table"  # table, simple, benchmark
  mock: true
  timeout: "5s"

runner:
  parallel: true
  workers: 4
  timeout: "30s"

coverage:
  threshold: 80
  exclude:
    - "*.pb.go"
    - "*_mock.go"

fixer:
  auto_apply: false  # 手動確認後に適用
  backup: true
```

## Data Types
```go
type TestCase struct {
    Name     string
    Input    interface{}
    Expected interface{}
    Error    bool
}

type TestResult struct {
    Output  string
    Error   error
    Passed  bool
    Runtime time.Duration
}

type Fix struct {
    Type        string // panic, timeout, race, logic
    Description string
    Line        int
    Suggestion  string
}

type CoverageResult struct {
    Percentage float64
    Output     string
    Error      error
}

type FileCoverage struct {
    Total      int
    Covered    int
    Percentage float64
    MissedLines []int
}
```

## Integration Points

### CI/CD Integration
```yaml
# .github/workflows/test.yml
- name: Run Test Specialist
  run: |
    go run agents/test-specialist.go run --coverage --threshold=80
    go run agents/test-specialist.go fix --auto-apply=false
```

### Git Hooks
```bash
#!/bin/sh
# pre-commit hook
go run agents/test-specialist.go run --quick
if [ $? -ne 0 ]; then
    echo "Tests failed. Commit aborted."
    exit 1
fi
```

## Performance Optimizations

1. **Parallel Execution**: テストの並列実行
2. **Smart Selection**: 変更されたファイルのみテスト
3. **Cache Results**: テスト結果のキャッシュ
4. **Incremental Coverage**: 差分カバレッジ計算

## Error Handling
```go
func handleTestError(err error, output string) []Fix {
    switch {
    case strings.Contains(output, "race detected"):
        return []Fix{{Type: "race", Description: "Add mutex protection"}}
    case strings.Contains(output, "connection refused"):
        return []Fix{{Type: "network", Description: "Add retry mechanism"}}
    case strings.Contains(output, "nil pointer"):
        return []Fix{{Type: "nil", Description: "Add nil check"}}
    default:
        return []Fix{{Type: "unknown", Description: "Manual investigation required"}}
    }
}
```

## Minimal Implementation Priority

1. **Phase 1**: Basic test generation (unit tests)
2. **Phase 2**: Test execution with simple reporting
3. **Phase 3**: Coverage analysis
4. **Phase 4**: Basic fix suggestions
5. **Phase 5**: CI/CD integration

Focus: 実用的な機能から段階的実装。複雑な機能は後回し。