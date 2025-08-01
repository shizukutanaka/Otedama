# Test Specialist Agent

自動テスト作成・実施・ソース修正を行う実用的なテストエージェント。

## Core Functions

### 1. Test Generation
```go
package main

import (
    "context"
    "fmt"
    "strings"
    "sync"
    "time"
    "os/exec"
    "os"
    "path/filepath"
    "runtime"
    "go/ast"
    "go/parser"
    "go/token"
    "regexp"
    "golang.org/x/tools/cover"
)

// TestCase represents a single test case
type TestCase struct {
    Name     string
    Input    interface{}
    Expected interface{}
    Error    bool
}

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

func generateTestCases(cases []TestCase) string {
    var caseStrings []string
    for _, tc := range cases {
        caseStr := fmt.Sprintf(`        {
            name:     "%s",
            input:    %v,
            expected: %v,
        }`, tc.Name, tc.Input, tc.Expected)
        caseStrings = append(caseStrings, caseStr)
    }
    return strings.Join(caseStrings, ",\n")
}
```

### 2. Test Execution
```go
// TestResult represents the result of a test run
type TestResult struct {
    Output  string
    Error   error
    Passed  bool
    Runtime time.Duration
}

// CoverageResult represents coverage analysis results
type CoverageResult struct {
    Percentage float64
    Output     string
    Error      error
}

// TestRunner - テスト実行
type TestRunner struct {
    timeout  time.Duration
    parallel bool
}

func (tr *TestRunner) RunTests(pattern string) *TestResult {
    start := time.Now()
    cmd := exec.Command("go", "test", "-v", pattern)
    if tr.parallel {
        // Use runtime.NumCPU() for optimal parallelism
        cmd.Args = append(cmd.Args, "-parallel", fmt.Sprintf("%d", runtime.NumCPU()))
    }
    
    // Add timeout to prevent hanging tests
    if tr.timeout > 0 {
        ctx, cancel := context.WithTimeout(context.Background(), tr.timeout)
        defer cancel()
        cmd = exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
    }
    
    output, err := cmd.CombinedOutput()
    return &TestResult{
        Output:  string(output),
        Error:   err,
        Passed:  err == nil,
        Runtime: time.Since(start),
    }
}

func (tr *TestRunner) RunWithCoverage(pattern string) *CoverageResult {
    // Use temporary file for coverage to avoid conflicts
    tmpFile, err := os.CreateTemp("", "coverage-*.out")
    if err != nil {
        return &CoverageResult{Error: err}
    }
    defer os.Remove(tmpFile.Name())
    
    cmd := exec.Command("go", "test", "-cover", fmt.Sprintf("-coverprofile=%s", tmpFile.Name()), pattern)
    if tr.parallel {
        cmd.Args = append(cmd.Args, "-parallel", fmt.Sprintf("%d", runtime.NumCPU()))
    }
    
    // Add timeout
    if tr.timeout > 0 {
        ctx, cancel := context.WithTimeout(context.Background(), tr.timeout)
        defer cancel()
        cmd = exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
    }
    
    output, err := cmd.CombinedOutput()
    coverage := parseCoverage(string(output))
    
    return &CoverageResult{
        Percentage: coverage,
        Output:     string(output),
        Error:      err,
    }
}

func parseCoverage(output string) float64 {
    lines := strings.Split(output, "\n")
    for _, line := range lines {
        if strings.Contains(line, "coverage:") {
            var percentage float64
            fmt.Sscanf(line, "coverage: %f%%", &percentage)
            return percentage
        }
    }
    return 0.0
}
```

### 3. Source Analysis & Fix
```go
// Fix represents a suggested fix for test failures
type Fix struct {
    Type        string // panic, timeout, race, logic
    Description string
    Line        int
    Suggestion  string
}

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
            Suggestion:  "if obj != nil { /* existing code */ }",
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
    
    // レース条件検出
    if strings.Contains(testOutput, "race detected") {
        fixes = append(fixes, Fix{
            Type:        "race",
            Description: "Add mutex protection",
            Suggestion:  "sync.Mutex{} // Add proper synchronization",
        })
    }
    
    return fixes
}

func (sa *SourceAnalyzer) ApplyFix(fix Fix) error {
    content, err := os.ReadFile(sa.filePath)
    if err != nil {
        return err
    }
    
    lines := strings.Split(string(content), "\n")
    if fix.Line > 0 && fix.Line <= len(lines) {
        lines[fix.Line-1] = fix.Suggestion
    }
    
    return os.WriteFile(sa.filePath, []byte(strings.Join(lines, "\n")), 0644)
}

func extractPanicLine(output string) int {
    lines := strings.Split(output, "\n")
    for i, line := range lines {
        if strings.Contains(line, "panic:") && i+1 < len(lines) {
            // Extract line number from stack trace
            var lineNum int
            fmt.Sscanf(lines[i+1], "%*s:%d", &lineNum)
            return lineNum
        }
    }
    return 0
}
```

### 4. Coverage Analysis
```go
// FileCoverage represents coverage data for a single file
type FileCoverage struct {
    Total       int
    Covered     int
    Percentage  float64
    MissedLines []int
}

// CoverageReport represents the complete coverage report
type CoverageReport struct {
    Files map[string]*FileCoverage
    Error error
}

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
        missedLines := []int{}
        
        for _, block := range profile.Blocks {
            total += block.NumStmt
            if block.Count > 0 {
                covered += block.NumStmt
            } else {
                // Track missed lines
                for line := block.StartLine; line <= block.EndLine; line++ {
                    missedLines = append(missedLines, line)
                }
            }
        }
        
        percentage := 0.0
        if total > 0 {
            percentage = float64(covered) / float64(total) * 100
        }
        
        report.Files[profile.FileName] = &FileCoverage{
            Total:       total,
            Covered:     covered,
            Percentage:  percentage,
            MissedLines: missedLines,
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

## Main Function Implementation
```go
func main() {
    if len(os.Args) < 2 {
        printUsage()
        os.Exit(1)
    }

    command := os.Args[1]
    
    switch command {
    case "generate":
        handleGenerate(os.Args[2:])
    case "run":
        handleRun(os.Args[2:])
    case "fix":
        handleFix(os.Args[2:])
    case "suggest":
        handleSuggest(os.Args[2:])
    default:
        fmt.Printf("Unknown command: %s\n", command)
        printUsage()
        os.Exit(1)
    }
}

func printUsage() {
    fmt.Println("Test Specialist - Automated Testing Tool")
    fmt.Println("\nUsage:")
    fmt.Println("  test-specialist generate --file=<file> | --dir=<dir>")
    fmt.Println("  test-specialist run [--all] [--coverage] [--threshold=<n>] [--package=<pkg>]")
    fmt.Println("  test-specialist fix --test-output=<file>")
    fmt.Println("  test-specialist suggest --coverage=<file>")
}

func handleGenerate(args []string) {
    var targetFile, targetDir string
    
    for _, arg := range args {
        if strings.HasPrefix(arg, "--file=") {
            targetFile = strings.TrimPrefix(arg, "--file=")
        } else if strings.HasPrefix(arg, "--dir=") {
            targetDir = strings.TrimPrefix(arg, "--dir=")
        }
    }
    
    if targetFile != "" {
        generateTestForFile(targetFile)
    } else if targetDir != "" {
        generateTestsForDir(targetDir)
    } else {
        fmt.Println("Error: Must specify --file or --dir")
        os.Exit(1)
    }
}

func handleRun(args []string) {
    var all, coverage bool
    var threshold int
    var pkg string = "./..."
    
    for _, arg := range args {
        switch {
        case arg == "--all":
            all = true
        case arg == "--coverage":
            coverage = true
        case strings.HasPrefix(arg, "--threshold="):
            fmt.Sscanf(arg, "--threshold=%d", &threshold)
        case strings.HasPrefix(arg, "--package="):
            pkg = strings.TrimPrefix(arg, "--package=")
        }
    }
    
    runner := &TestRunner{parallel: true, timeout: 30 * time.Second}
    
    if coverage {
        result := runner.RunWithCoverage(pkg)
        fmt.Println(result.Output)
        
        if threshold > 0 && result.Percentage < float64(threshold) {
            fmt.Printf("Coverage %.2f%% is below threshold %d%%\n", result.Percentage, threshold)
            os.Exit(1)
        }
    } else {
        result := runner.RunTests(pkg)
        fmt.Println(result.Output)
        if !result.Passed {
            os.Exit(1)
        }
    }
}

func handleFix(args []string) {
    var testOutput string
    
    for _, arg := range args {
        if strings.HasPrefix(arg, "--test-output=") {
            testOutput = strings.TrimPrefix(arg, "--test-output=")
        }
    }
    
    if testOutput == "" {
        fmt.Println("Error: Must specify --test-output")
        os.Exit(1)
    }
    
    content, err := os.ReadFile(testOutput)
    if err != nil {
        fmt.Printf("Error reading test output: %v\n", err)
        os.Exit(1)
    }
    
    analyzer := &SourceAnalyzer{}
    fixes := analyzer.AnalyzeTestFailures(string(content))
    
    fmt.Printf("Found %d potential fixes:\n", len(fixes))
    for i, fix := range fixes {
        fmt.Printf("%d. %s: %s\n", i+1, fix.Type, fix.Description)
        if fix.Suggestion != "" {
            fmt.Printf("   Suggestion: %s\n", fix.Suggestion)
        }
    }
}

func handleSuggest(args []string) {
    var coverageFile string
    
    for _, arg := range args {
        if strings.HasPrefix(arg, "--coverage=") {
            coverageFile = strings.TrimPrefix(arg, "--coverage=")
        }
    }
    
    if coverageFile == "" {
        fmt.Println("Error: Must specify --coverage")
        os.Exit(1)
    }
    
    analyzer := &CoverageAnalyzer{}
    report := analyzer.AnalyzeCoverage(coverageFile)
    
    if report.Error != nil {
        fmt.Printf("Error analyzing coverage: %v\n", report.Error)
        os.Exit(1)
    }
    
    for file, cov := range report.Files {
        if cov.Percentage < 80 {
            fmt.Printf("\n%s: %.2f%% coverage\n", file, cov.Percentage)
            fmt.Printf("  Uncovered lines: %v\n", cov.MissedLines[:min(10, len(cov.MissedLines))])
            if len(cov.MissedLines) > 10 {
                fmt.Printf("  ... and %d more lines\n", len(cov.MissedLines)-10)
            }
        }
    }
}

// Cache for parsed AST to avoid re-parsing
var astCache = make(map[string]*ast.File)
var astCacheMu sync.RWMutex

func generateTestForFile(filePath string) {
    fmt.Printf("Generating tests for %s\n", filePath)
    
    // Check cache first
    astCacheMu.RLock()
    node, cached := astCache[filePath]
    astCacheMu.RUnlock()
    
    if !cached {
        // Parse the Go file
        fset := token.NewFileSet()
        var err error
        node, err = parser.ParseFile(fset, filePath, nil, parser.ParseComments)
        if err != nil {
            fmt.Printf("Error parsing file: %v\n", err)
            return
        }
        
        // Cache the AST
        astCacheMu.Lock()
        astCache[filePath] = node
        astCacheMu.Unlock()
    }
    
    generator := &TestGenerator{targetFile: filePath}
    var testBuilder strings.Builder
    testBuilder.WriteString("package ")
    testBuilder.WriteString(node.Name.Name)
    testBuilder.WriteString("_test\n\nimport \"testing\"\n")
    
    // Generate tests for each function
    ast.Inspect(node, func(n ast.Node) bool {
        if fn, ok := n.(*ast.FuncDecl); ok && fn.Name.IsExported() {
            testBuilder.WriteString(generator.GenerateUnitTest(fn.Name.Name))
            testBuilder.WriteString("\n\n")
        }
        return true
    })
    
    // Write test file
    testFile := strings.Replace(filePath, ".go", "_test.go", 1)
    err := os.WriteFile(testFile, []byte(testBuilder.String()), 0644)
    if err != nil {
        fmt.Printf("Error writing test file: %v\n", err)
    } else {
        fmt.Printf("Generated %s\n", testFile)
    }
}

func generateTestsForDir(dir string) {
    // Collect all files first
    var files []string
    err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
            files = append(files, path)
        }
        return nil
    })
    
    if err != nil {
        fmt.Printf("Error walking directory: %v\n", err)
        return
    }
    
    // Process files in parallel
    var wg sync.WaitGroup
    semaphore := make(chan struct{}, runtime.NumCPU())
    
    for _, file := range files {
        wg.Add(1)
        go func(f string) {
            defer wg.Done()
            semaphore <- struct{}{}
            generateTestForFile(f)
            <-semaphore
        }(file)
    }
    
    wg.Wait()
}

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
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
    fixes := []Fix{}
    
    switch {
    case strings.Contains(output, "race detected"):
        fixes = append(fixes, Fix{
            Type:        "race",
            Description: "Add mutex protection",
            Suggestion:  "var mu sync.Mutex // Add at struct level",
        })
    case strings.Contains(output, "connection refused"):
        fixes = append(fixes, Fix{
            Type:        "network",
            Description: "Add retry mechanism",
            Suggestion:  "Use exponential backoff retry",
        })
    case strings.Contains(output, "nil pointer dereference"):
        fixes = append(fixes, Fix{
            Type:        "nil",
            Description: "Add nil check",
            Suggestion:  "if obj == nil { return fmt.Errorf(\"object is nil\") }",
        })
    case strings.Contains(output, "index out of range"):
        fixes = append(fixes, Fix{
            Type:        "bounds",
            Description: "Add bounds check",
            Suggestion:  "if idx >= 0 && idx < len(slice) { /* safe access */ }",
        })
    case strings.Contains(output, "deadlock"):
        fixes = append(fixes, Fix{
            Type:        "deadlock",
            Description: "Review locking order",
            Suggestion:  "Ensure consistent lock acquisition order",
        })
    default:
        fixes = append(fixes, Fix{
            Type:        "unknown",
            Description: "Manual investigation required",
            Suggestion:  "Check test output for specific error details",
        })
    }
    
    return fixes
}

// Additional helper for comprehensive error analysis
func analyzeErrorContext(output string) map[string]interface{} {
    context := make(map[string]interface{})
    
    // Extract file and line numbers from stack traces
    stackPattern := regexp.MustCompile(`(\S+\.go):(\d+)`)
    matches := stackPattern.FindAllStringSubmatch(output, -1)
    
    if len(matches) > 0 {
        context["file"] = matches[0][1]
        context["line"] = matches[0][2]
    }
    
    // Identify error type
    errorTypes := []string{"panic", "timeout", "race", "deadlock", "nil pointer"}
    for _, errType := range errorTypes {
        if strings.Contains(strings.ToLower(output), errType) {
            context["error_type"] = errType
            break
        }
    }
    
    return context
}
```

## Minimal Implementation Priority

1. **Phase 1**: Basic test generation (unit tests)
2. **Phase 2**: Test execution with simple reporting
3. **Phase 3**: Coverage analysis
4. **Phase 4**: Basic fix suggestions
5. **Phase 5**: CI/CD integration

Focus: 実用的な機能から段階的実装。複雑な機能は後回し。