# Contributing to Otedama

Thank you for your interest in contributing to Otedama! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Pull Request Process](#pull-request-process)
- [Community](#community)

## Code of Conduct

### Our Pledge

We are committed to providing a friendly, safe, and welcoming environment for all contributors, regardless of experience level, gender identity, sexual orientation, disability, personal appearance, body size, race, ethnicity, age, religion, or nationality.

### Expected Behavior

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive criticism
- Accept feedback gracefully
- Prioritize the project's best interests

### Unacceptable Behavior

- Harassment, discrimination, or offensive comments
- Personal attacks or trolling
- Publishing private information without consent
- Any conduct that could reasonably be considered inappropriate

## Getting Started

### Prerequisites

- Go 1.21 or higher
- Git
- Docker (optional, for containerized development)
- PostgreSQL 14+ (for database)
- Redis (for caching)

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork:
```bash
git clone https://github.com/YOUR-USERNAME/Otedama.git
cd Otedama
```

3. Add upstream remote:
```bash
git remote add upstream https://github.com/shizukutanaka/Otedama.git
```

## Development Setup

### 1. Install Dependencies

```bash
# Install Go dependencies
go mod download
go mod verify

# Install development tools
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
go install golang.org/x/tools/cmd/goimports@latest
```

### 2. Set Up Database

```bash
# Start PostgreSQL with Docker
docker run -d \
  --name otedama-db \
  -e POSTGRES_USER=otedama \
  -e POSTGRES_PASSWORD=otedama \
  -e POSTGRES_DB=otedama \
  -p 5432:5432 \
  postgres:14

# Run migrations
go run cmd/migrate/main.go up
```

### 3. Configure Application

```bash
# Copy example configuration
cp config/config.example.yaml config/config.yaml

# Edit configuration as needed
nano config/config.yaml
```

### 4. Run Tests

```bash
# Run all tests
go test ./...

# Run with coverage
go test -cover ./...

# Run specific package tests
go test ./internal/mining/...
```

## How to Contribute

### Types of Contributions

1. **Bug Reports**: Found a bug? Open an issue with detailed reproduction steps
2. **Feature Requests**: Have an idea? Discuss it in an issue first
3. **Code Contributions**: Fix bugs, add features, improve performance
4. **Documentation**: Improve docs, add examples, translate to other languages
5. **Testing**: Add test cases, improve test coverage
6. **Reviews**: Review pull requests and provide feedback

### Finding Issues to Work On

- Check issues labeled `good-first-issue` for beginners
- Look for `help-wanted` labels for priority items
- Review the [ROADMAP.md](./docs/en/ROADMAP.md) for planned features

## Coding Standards

### Go Code Style

Follow the official [Go Code Review Comments](https://github.com/golang/go/wiki/CodeReviewComments) and:

```go
// Good: Clear, idiomatic Go
func CalculateReward(shares int64, difficulty *big.Int) *big.Int {
    if shares <= 0 || difficulty == nil {
        return big.NewInt(0)
    }
    // Implementation...
}

// Bad: Non-idiomatic
func calc_reward(s int64, d *big.Int) *big.Int {
    // Missing validation
    // Implementation...
}
```

### File Organization

- One concept per file
- Test files alongside implementation
- Clear, descriptive names

### Error Handling

```go
// Always handle errors explicitly
result, err := SomeOperation()
if err != nil {
    return fmt.Errorf("operation failed: %w", err)
}
```

### Comments and Documentation

```go
// CalculateHashrate computes the mining hashrate based on
// the number of valid shares submitted within the time window.
// It returns the hashrate in hashes per second.
func CalculateHashrate(shares int64, duration time.Duration) float64 {
    // Implementation
}
```

## Testing Guidelines

### Test Structure

```go
func TestCalculateReward(t *testing.T) {
    tests := []struct {
        name       string
        shares     int64
        difficulty *big.Int
        want       *big.Int
    }{
        {
            name:       "valid shares",
            shares:     100,
            difficulty: big.NewInt(1000),
            want:       big.NewInt(100000),
        },
        // More test cases...
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := CalculateReward(tt.shares, tt.difficulty)
            if got.Cmp(tt.want) != 0 {
                t.Errorf("got %v, want %v", got, tt.want)
            }
        })
    }
}
```

### Test Coverage

- Aim for >80% code coverage
- Test edge cases and error conditions
- Include benchmarks for performance-critical code

## Documentation

### Code Documentation

- Add godoc comments to all exported types and functions
- Include examples where helpful
- Keep comments up-to-date with code changes

### Markdown Documentation

- Use clear, concise language
- Include code examples
- Add diagrams for complex concepts
- Update relevant docs when making changes

### Translations

When contributing translations:
1. Use native language, not machine translation
2. Maintain consistent terminology
3. Update the language index file

## Pull Request Process

### 1. Before Starting

- Discuss major changes in an issue first
- Check if someone else is already working on it
- Ensure your fork is up-to-date with upstream

### 2. Branch Naming

```bash
# Feature branches
git checkout -b feature/add-new-algorithm

# Bug fix branches
git checkout -b fix/memory-leak-in-mining

# Documentation branches
git checkout -b docs/update-deployment-guide
```

### 3. Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add SHA3 mining algorithm support
fix: resolve memory leak in worker pool
docs: update Japanese README
test: add benchmarks for hash functions
refactor: optimize database connection pooling
```

### 4. Pull Request Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Performance improvement

## Testing
- [ ] Tests pass locally
- [ ] Added new tests
- [ ] Updated documentation

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] No sensitive data exposed
```

### 5. Review Process

1. Submit PR against `main` branch
2. Ensure CI checks pass
3. Address reviewer feedback
4. Squash commits if requested
5. Wait for approval from maintainers

## Community

### Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General discussions and questions
<!-- Discord channel removed until available -->

### Getting Help

- Read existing documentation first
- Search closed issues for similar problems
- Ask clear, specific questions
- Provide context and examples

## Recognition

Contributors are recognized in:
- [CONTRIBUTORS.md](./CONTRIBUTORS.md) file
- Release notes
- Project documentation

## Checklist for Contributors

Before submitting a PR, ensure:

- [ ] Code compiles without warnings
- [ ] All tests pass
- [ ] New code has tests
- [ ] Documentation is updated
- [ ] Commit messages follow convention
- [ ] PR description is complete
- [ ] No merge conflicts
- [ ] Sensitive data is not exposed

## Security

### Reporting Security Issues

Do not open public issues for security vulnerabilities. Instead, please use GitHub Security Advisories:

- Submit a private report: https://github.com/shizukutanaka/Otedama/security/advisories/new
- Include a detailed description and reproduction steps
- Allow maintainers time to investigate and release a fix before public disclosure

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Otedama! Your efforts help make this project better for everyone.

*Questions? Open an issue or reach out to the maintainers.*