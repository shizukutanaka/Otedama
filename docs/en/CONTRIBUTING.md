# Contributing to Otedama

Thank you for your interest in contributing to Otedama! This guide will help you get started with contributing to our multi-algorithm mining pool platform.

## Language Support

This guide is available in multiple languages:
- [English](CONTRIBUTING.md)
- [日本語](CONTRIBUTING.ja.md)
- [中文](CONTRIBUTING.zh.md)
- [Español](CONTRIBUTING.es.md)
- [Deutsch](CONTRIBUTING.de.md)

## How to Contribute

### Code Contributions
1. **Fork the repository** on GitHub
2. **Create a feature branch** from `main`
3. **Write tests** for your changes
4. **Ensure all tests pass** with `go test ./...`
5. **Submit a pull request** with clear description

### Documentation Contributions
1. **Improve existing docs** in any language
2. **Add new translations** for supported languages
3. **Fix typos or clarify** unclear sections
4. **Add examples** and use cases

### Bug Reports
1. **Search existing issues** before creating new ones
2. **Provide clear reproduction steps**
3. **Include system information**
4. **Add relevant logs** or screenshots

## Development Setup

### Prerequisites
- Go 1.21 or higher
- Docker (optional)
- Git
- Make

### Local Development
```bash
# Clone repository
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# Install dependencies
go mod tidy

# Run tests
go test ./...

# Run with Docker
docker-compose up
```

## Testing

### Unit Tests
```bash
go test ./... -v
```

### Integration Tests
```bash
go test ./tests/integration/... -v
```

### Performance Tests
```bash
go test ./tests/performance/... -v -bench=.
```

## Code Style

### Go Code Style
- Follow [Effective Go](https://golang.org/doc/effective_go.html)
- Use `gofmt` and `goimports`
- Write clear, concise comments
- Use meaningful variable names

### Documentation Style
- Use clear, simple language
- Include code examples
- Maintain consistent formatting
- Update translations when changing English

## Review Process

### Code Review
1. **Automated checks** must pass
2. **Peer review** by maintainers
3. **Testing** on multiple environments
4. **Documentation** updates if needed

### Documentation Review
1. **Language accuracy** verified
2. **Technical accuracy** confirmed
3. **Formatting consistency** checked
4. **Cross-references** validated

## Issue Labels

### Priority
- `priority/high` - Critical issues
- `priority/medium` - Important issues
- `priority/low` - Nice to have

### Type
- `bug` - Something isn't working
- `enhancement` - New feature or improvement
- `documentation` - Documentation changes
- `translation` - Language translations

## Getting Help

### Community
- **GitHub Discussions** for questions
- **Discord** for real-time chat
- **Email** for security issues

### Resources
- [Developer Guide](DEVELOPMENT.md)
- [API Documentation](../api/README.md)
- [Architecture Guide](../architecture/README.md)

## Contribution Areas

### High Priority
- Multi-algorithm optimization
- Security improvements
- Performance enhancements
- Bug fixes

### Medium Priority
- New algorithm support
- Documentation improvements
- Testing improvements
- User experience enhancements

### Low Priority
- Code cleanup
- Refactoring
- Minor optimizations

## Recognition

Contributors are recognized in:
- **CHANGELOG.md** for significant contributions
- **README.md** contributors section
- **GitHub** contributor graphs

## 📄 License

By contributing, you agree that your contributions will be licensed under the same license as the project.

---

Thank you for helping make Otedama better!
