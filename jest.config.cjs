module.exports = {
  testEnvironment: 'node',
  preset: 'es6',
  extensionsToTreatAsEsm: ['.js'],
  globals: {
    'ts-jest': {
      useESM: true
    }
  },
  moduleNameMapping: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
  collectCoverageFrom: [
    'lib/**/*.js',
    '!lib/**/node_modules/**',
    '!lib/**/*.test.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testMatch: [
    '**/test/**/*.test.js',
    '**/test/**/*.spec.js'
  ],
  verbose: true,
  maxWorkers: '50%',
  testTimeout: 10000,
  setupFilesAfterEnv: ['<rootDir>/test/jest-setup.js']
};