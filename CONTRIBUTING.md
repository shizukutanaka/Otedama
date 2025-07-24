# Contributing to Otedama

First off, thank you for considering contributing to Otedama! It's people like you that make Otedama such a great tool for the global mining community.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Process](#development-process)
- [Style Guidelines](#style-guidelines)
- [Translation Guidelines](#translation-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Community](#community)

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

### Our Standards

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Accept constructive criticism gracefully
- Focus on what is best for the community
- Show empathy towards other community members

## Getting Started

### Prerequisites

- Node.js 16+ installed
- Git installed
- Basic knowledge of JavaScript/TypeScript
- Understanding of mining pool concepts (helpful but not required)

### Setting Up Your Development Environment

1. **Fork the repository**
   ```bash
   # Click the 'Fork' button on GitHub
   ```

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/otedama.git
   cd otedama
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/otedama/otedama.git
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Run tests**
   ```bash
   npm test
   ```

6. **Start development server**
   ```bash
   npm run dev
   ```

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples**
- **Include your environment details** (OS, Node.js version, etc.)
- **Attach screenshots if applicable**
- **Include error messages and stack traces**

### Suggesting Enhancements

Enhancement suggestions are welcome! Please provide:

- **Clear and descriptive title**
- **Detailed description of the proposed functionality**
- **Explain why this enhancement would be useful**
- **List any alternative solutions you've considered**
- **Include mockups or examples if applicable**

### Your First Code Contribution

Unsure where to begin? Look for these tags in our issues:

- `good first issue` - Simple issues perfect for beginners
- `help wanted` - Issues where we need community help
- `documentation` - Help improve our docs
- `translation` - Help translate to new languages

### Pull Requests

1. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```

2. **Make your changes**
   - Write clean, readable code
   - Add tests for new functionality
   - Update documentation as needed

3. **Commit your changes**
   ```bash
   git commit -m "Add amazing feature"
   ```

4. **Push to your fork**
   ```bash
   git push origin feature/amazing-feature
   ```

5. **Open a Pull Request**
   - Use our PR template
   - Link related issues
   - Describe your changes clearly

## Development Process

### Branching Strategy

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `hotfix/*` - Urgent production fixes

### Testing

All code must have appropriate test coverage:

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

### Code Quality

```bash
# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Type checking
npm run type-check
```

## Style Guidelines

### JavaScript/TypeScript Style

We follow the [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript) with some modifications:

- Use 2 spaces for indentation
- Use semicolons
- Use single quotes for strings
- Maximum line length of 100 characters

Example:
```javascript
// Good
const miner = {
  address: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
  hashrate: 1000000,
  shares: 42
};

// Bad
const miner={address:"1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa",hashrate:1000000,shares:42}
```

### File Naming

- Use kebab-case for file names: `payment-processor.js`
- Use PascalCase for classes: `PaymentProcessor`
- Use camelCase for variables and functions: `processPayment()`

### Comments

- Write self-documenting code
- Use JSDoc for functions and classes
- Keep comments concise and relevant

```javascript
/**
 * Process payments for miners
 * @param {Array<Miner>} miners - List of miners to pay
 * @returns {Promise<PaymentResult>} Payment transaction results
 */
async function processPayments(miners) {
  // Implementation
}
```

## Translation Guidelines

We support 100+ languages! To contribute translations:

### Adding a New Language

1. **Create language file**
   ```bash
   cp lib/i18n/locales/en.json lib/i18n/locales/YOUR_LANG_CODE.json
   ```

2. **Update language manager**
   ```javascript
   // In lib/i18n/language-manager.js
   'YOUR_LANG_CODE': {
     name: 'Language Name',
     nativeName: 'Native Name',
     rtl: false // Set true for RTL languages
   }
   ```

3. **Translate all keys**
   - Keep placeholders like `{{variable}}`
   - Maintain the same JSON structure
   - Consider cultural context

### Translation Best Practices

- Use formal language for professional terms
- Be consistent with terminology
- Test RTL languages thoroughly
- Include number and date format preferences

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples
```bash
feat(mining): add support for RandomX algorithm

fix(payment): correct fee calculation for small pools

docs(api): update REST API documentation

chore(deps): update dependency ws to v8.14.2
```

## Pull Requests

### PR Title Format
Use the same format as commit messages:
```
feat(component): add amazing new feature
```

### PR Description Template
```markdown
## Description
Brief description of what this PR does

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Checklist
- [ ] My code follows the style guidelines
- [ ] I have performed a self-review
- [ ] I have commented my code where necessary
- [ ] I have updated the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests for my changes
- [ ] All tests pass locally
```

### Review Process

1. All PRs require at least one review
2. CI must pass (tests, linting, type checking)
3. No merge conflicts
4. Documentation updated if needed

## Community

### Communication Channels

- **Discord**: [Discord Server]
- **GitHub Discussions**: For feature requests and general discussions
- **Stack Overflow**: Tag questions with `otedama`

### Getting Help

- Check our documentation
- Search existing issues and discussions
- Ask in Discord #help channel
- Create a detailed issue if needed

### Recognition

We value all contributions! Contributors are:
- Listed in our CONTRIBUTORS.md file
- Mentioned in release notes
- Given special roles in our Discord
- Eligible for Otedama contributor NFTs

## Development Tips

### Debugging

```bash
# Enable debug logging
DEBUG=otedama:* npm run dev

# Run specific tests
npm test -- --testNamePattern="PaymentProcessor"
```

### Performance Testing

```bash
# Run benchmarks
npm run benchmark

# Profile memory usage
node --inspect index.js
```

### Security

- Never commit sensitive data
- Use environment variables for secrets
- Run security audit: `npm audit`
- Report security issues privately to the project maintainers

## Legal

By contributing to Otedama, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Otedama! Your efforts help make mining accessible to everyone worldwide. 🌍⛏️

Creator Address: 1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa