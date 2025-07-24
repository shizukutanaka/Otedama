# Contributing to Otedama

Thank you for your interest in contributing to Otedama! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive criticism
- Respect differing viewpoints and experiences

## How to Contribute

### Reporting Issues

1. Check existing issues to avoid duplicates
2. Use issue templates when available
3. Provide clear reproduction steps
4. Include system information and logs

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass (`npm test`)
6. Commit with clear messages
7. Push to your fork
8. Open a Pull Request

### Commit Messages

Follow conventional commits format:

```
type(scope): subject

body

footer
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test additions/changes
- `chore`: Build process or auxiliary tool changes

### Code Style

- Use 2 spaces for indentation
- Use semicolons
- Use single quotes for strings
- Add JSDoc comments for functions
- Follow existing patterns in codebase

### Testing

- Write unit tests for new features
- Ensure 80%+ code coverage
- Run tests before submitting PR:
  ```bash
  npm test
  npm run test:coverage
  ```

### Documentation

- Update README.md if needed
- Add JSDoc comments
- Update CHANGELOG.md
- Include examples for new features

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/otedama.git
cd otedama

# Install dependencies
npm install

# Run development mode
npm run dev

# Run tests
npm test

# Lint code
npm run lint
```

## Pull Request Process

1. Update documentation
2. Add tests for new functionality
3. Ensure CI passes
4. Request review from maintainers
5. Address review feedback
6. Squash commits if requested

## Release Process

Releases are managed by maintainers following semantic versioning.

## Questions?

- Open a discussion on GitHub
- Join our community chat
- Email: dev@otedama.io

Thank you for contributing!