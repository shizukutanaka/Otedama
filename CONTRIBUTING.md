# Contributing to Otedama

First off, thank you for considering contributing to Otedama! It's people like you that make Otedama such a great tool.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

* **Use a clear and descriptive title**
* **Describe the exact steps which reproduce the problem**
* **Provide specific examples to demonstrate the steps**
* **Describe the behavior you observed after following the steps**
* **Explain which behavior you expected to see instead and why**
* **Include logs and stack traces if applicable**

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

* **Use a clear and descriptive title**
* **Provide a step-by-step description of the suggested enhancement**
* **Provide specific examples to demonstrate the steps**
* **Describe the current behavior and explain which behavior you expected to see instead**
* **Explain why this enhancement would be useful**

### Pull Requests

* Fill in the required template
* Do not include issue numbers in the PR title
* Follow the JavaScript styleguide
* Include thoughtfully-worded, well-structured tests
* Document new code
* End all files with a newline

## Development Process

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. If you've changed APIs, update the documentation
4. Ensure the test suite passes
5. Make sure your code lints
6. Issue that pull request!

## Styleguides

### Git Commit Messages

* Use the present tense ("Add feature" not "Added feature")
* Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
* Limit the first line to 72 characters or less
* Reference issues and pull requests liberally after the first line

### JavaScript Styleguide

* 2 spaces for indentation
* Prefer ES6+ features
* Use meaningful variable names
* Comment complex logic
* Keep functions small and focused

### Documentation Styleguide

* Use Markdown
* Reference function names, classes, and modules in backticks
* Include code examples where applicable

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- path/to/test.js

# Run with coverage
npm run test:coverage
```

## Project Structure

```
lib/
├── core/          # Core utilities
├── network/       # Networking layer
├── mining/        # Mining pool logic
├── security/      # Security features
├── monitoring/    # Monitoring and metrics
├── storage/       # Data persistence
├── api/          # External APIs
└── utils/        # Utilities
```

## Setting Up Development Environment

```bash
# Clone your fork
git clone https://github.com/yourusername/otedama.git
cd otedama

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Configure your environment
nano .env

# Run in development mode
npm run dev
```

## Performance Considerations

When contributing, please keep in mind:

* Minimize memory allocations
* Use buffer pools where appropriate
* Avoid blocking operations
* Profile your code for performance impacts

## Questions?

Feel free to open an issue with your question or reach out on our Discord channel.

Thank you for contributing! 🎉