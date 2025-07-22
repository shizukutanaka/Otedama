module.exports = {
    testEnvironment: 'node',
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'lib/**/*.js',
        '!lib/**/*.test.js',
        '!lib/**/index.js'
    ],
    testMatch: [
        '**/tests/**/*.test.js',
        '**/tests/**/*.spec.js'
    ],
    coverageThreshold: {
        global: {
            branches: 70,
            functions: 70,
            lines: 70,
            statements: 70
        }
    },
    setupFilesAfterEnv: ['./tests/setup.js'],
    testTimeout: 10000,
    verbose: true
};