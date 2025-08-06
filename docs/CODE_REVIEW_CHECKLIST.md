# Code Review Checklist

**Version**: 2.1.5  
**Last Updated**: 2025-08-05  

## Overview

This checklist ensures consistent, high-quality code reviews for the Otedama project. Use it for all pull requests and code changes.

## Pre-Review Checks

### Build and Tests
- [ ] Code compiles without errors or warnings
- [ ] All tests pass (`make test`)
- [ ] No test coverage regression
- [ ] Benchmarks show no performance regression

### Code Quality
- [ ] Linter passes (`make lint`)
- [ ] Code is properly formatted (`make fmt`)
- [ ] No `go vet` issues
- [ ] Security scan passes (`make security-scan`)

## Code Review Areas

### 1. Functionality
- [ ] Code does what it's supposed to do
- [ ] Edge cases are handled
- [ ] Error conditions are properly managed
- [ ] No obvious bugs or logic errors

### 2. Design and Architecture
- [ ] Follows established patterns in the codebase
- [ ] Appropriate abstraction level
- [ ] No unnecessary complexity
- [ ] Interfaces are well-designed and minimal
- [ ] Dependencies are appropriate

### 3. Code Quality

#### Naming
- [ ] Variables have descriptive names
- [ ] Functions clearly indicate their purpose
- [ ] Constants are properly named (ALL_CAPS or CamelCase)
- [ ] No abbreviations unless widely understood

#### Functions
- [ ] Functions are focused (single responsibility)
- [ ] Functions are under 50 lines
- [ ] Parameters are limited (max 5)
- [ ] Return values are clear

#### Error Handling
- [ ] All errors are checked
- [ ] Errors are wrapped with context
- [ ] Custom error types used appropriately
- [ ] No silent failures

### 4. Documentation
- [ ] All exported types have documentation
- [ ] All exported functions have documentation
- [ ] Complex logic has inline comments
- [ ] Documentation is accurate and helpful
- [ ] Examples provided where beneficial

### 5. Testing
- [ ] New code has tests
- [ ] Tests are meaningful (not just coverage)
- [ ] Table-driven tests used where appropriate
- [ ] Edge cases are tested
- [ ] Error paths are tested
- [ ] Tests are maintainable

### 6. Performance
- [ ] No obvious performance issues
- [ ] Efficient algorithms used
- [ ] Memory allocations minimized
- [ ] Concurrent code is correct
- [ ] No unnecessary locks or blocking

### 7. Security
- [ ] Input validation is thorough
- [ ] No SQL injection vulnerabilities
- [ ] No hardcoded secrets
- [ ] Authentication/authorization correct
- [ ] Rate limiting applied where needed
- [ ] Sanitization of user input

### 8. Concurrency
- [ ] Race conditions prevented
- [ ] Proper synchronization used
- [ ] Channels used correctly
- [ ] Context propagation correct
- [ ] Goroutine leaks prevented

### 9. Resource Management
- [ ] Resources are properly closed
- [ ] Contexts have timeouts
- [ ] No resource leaks
- [ ] Graceful shutdown handled
- [ ] Cleanup code uses defer

### 10. Maintainability
- [ ] Code is easy to understand
- [ ] No code duplication
- [ ] Constants used instead of magic numbers
- [ ] Configuration is externalized
- [ ] Logging is appropriate

## Specific Otedama Checks

### Mining Engine
- [ ] Hash calculations are correct
- [ ] Difficulty adjustments are proper
- [ ] Share validation is accurate
- [ ] Algorithm switching is safe

### P2P Network
- [ ] Connection handling is robust
- [ ] Message validation is thorough
- [ ] Peer discovery works correctly
- [ ] Network splits are handled

### Pool Management
- [ ] Payout calculations are accurate
- [ ] Share tracking is correct
- [ ] Worker management is efficient
- [ ] Database operations are optimized

### Security Features
- [ ] DDoS protection is effective
- [ ] Rate limiting works correctly
- [ ] Authentication is secure
- [ ] Audit logging is complete

## Post-Review Actions

### Approval Criteria
- [ ] All checklist items addressed
- [ ] No blocking issues remain
- [ ] Performance impact acceptable
- [ ] Security review passed
- [ ] Documentation complete

### Before Merge
- [ ] Rebase on latest main branch
- [ ] Squash commits if needed
- [ ] Update CHANGELOG if applicable
- [ ] Verify CI/CD passes

## Review Comments Guide

### Effective Comments
- Be specific about issues
- Provide examples of better approaches
- Link to relevant documentation
- Suggest concrete improvements
- Acknowledge good practices

### Comment Priorities
- **MUST**: Blocking issues that must be fixed
- **SHOULD**: Important improvements recommended
- **CONSIDER**: Suggestions for consideration
- **NITPICK**: Minor style or preference issues

## Example Review Comment

```
MUST: This function doesn't handle the case where `workerID` is empty, 
which could cause a panic in the map lookup below.

Suggest adding validation:
```go
if workerID == "" {
    return nil, ErrInvalidWorkerID
}
```

See our validation utilities in `internal/utils/validation.go` for 
consistent error handling.
```

## Reviewer Responsibilities

1. **Be Timely**: Review within 24 hours if possible
2. **Be Thorough**: Check all aspects of the code
3. **Be Constructive**: Focus on improving the code
4. **Be Teaching**: Help others learn and improve
5. **Be Respectful**: Keep feedback professional

## Author Responsibilities

1. **Self-Review First**: Check your own code against this list
2. **Provide Context**: Explain complex changes in PR description
3. **Respond Promptly**: Address review comments quickly
4. **Ask Questions**: Clarify feedback if needed
5. **Update Tests**: Ensure tests reflect changes