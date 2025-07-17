#!/usr/bin/env node

/**
 * Otedama Test Runner
 * Comprehensive automated testing suite
 * Following Robert C. Martin's testing principles
 */

import { performance } from 'perf_hooks';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class TestRunner {
    constructor() {
        this.tests = [];
        this.suites = new Map();
        this.results = {
            passed: 0,
            failed: 0,
            skipped: 0,
            total: 0,
            startTime: 0,
            endTime: 0,
            failures: [],
            duration: 0
        };
        
        this.config = {
            verbose: process.env.VERBOSE === 'true',
            bail: process.env.BAIL === 'true',
            timeout: parseInt(process.env.TEST_TIMEOUT) || 5000,
            parallel: process.env.PARALLEL !== 'false',
            filter: process.env.TEST_FILTER || null,
            coverage: process.env.COVERAGE === 'true'
        };
        
        this.hooks = {
            beforeAll: [],
            afterAll: [],
            beforeEach: [],
            afterEach: []
        };
    }

    /**
     * Test suite definition
     */
    describe(name, fn) {
        const suite = {
            name,
            tests: [],
            beforeAll: [],
            afterAll: [],
            beforeEach: [],
            afterEach: [],
            parent: this.currentSuite
        };
        
        this.suites.set(name, suite);
        const previousSuite = this.currentSuite;
        this.currentSuite = suite;
        
        fn();
        
        this.currentSuite = previousSuite;
        return suite;
    }

    /**
     * Test case definition
     */
    it(name, fn) {
        const test = {
            name,
            fn,
            suite: this.currentSuite,
            timeout: this.config.timeout,
            skip: false,
            only: false
        };
        
        if (this.currentSuite) {
            this.currentSuite.tests.push(test);
        } else {
            this.tests.push(test);
        }
        
        return test;
    }

    /**
     * Skip test
     */
    skip(name, fn) {
        const test = this.it(name, fn);
        test.skip = true;
        return test;
    }

    /**
     * Run only this test
     */
    only(name, fn) {
        const test = this.it(name, fn);
        test.only = true;
        return test;
    }

    /**
     * Setup hooks
     */
    beforeAll(fn) {
        if (this.currentSuite) {
            this.currentSuite.beforeAll.push(fn);
        } else {
            this.hooks.beforeAll.push(fn);
        }
    }

    afterAll(fn) {
        if (this.currentSuite) {
            this.currentSuite.afterAll.push(fn);
        } else {
            this.hooks.afterAll.push(fn);
        }
    }

    beforeEach(fn) {
        if (this.currentSuite) {
            this.currentSuite.beforeEach.push(fn);
        } else {
            this.hooks.beforeEach.push(fn);
        }
    }

    afterEach(fn) {
        if (this.currentSuite) {
            this.currentSuite.afterEach.push(fn);
        } else {
            this.hooks.afterEach.push(fn);
        }
    }

    /**
     * Assertion library
     */
    expect(actual) {
        return new Assertion(actual);
    }

    /**
     * Load test files
     */
    async loadTests() {
        const testDir = path.join(__dirname);
        const files = await this.getTestFiles(testDir);
        
        for (const file of files) {
            if (this.config.filter && !file.includes(this.config.filter)) {
                continue;
            }
            
            try {
                await import(file);
            } catch (error) {
                console.error(`Failed to load test file ${file}:`, error);
            }
        }
    }

    async getTestFiles(dir) {
        const files = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                files.push(...await this.getTestFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
                files.push(fullPath);
            }
        }
        
        return files;
    }

    /**
     * Run all tests
     */
    async run() {
        console.log('🧪 Running Otedama Test Suite...\n');
        
        this.results.startTime = Date.now();
        
        try {
            // Load all test files
            await this.loadTests();
            
            // Check for only tests
            const onlyTests = this.getAllTests().filter(t => t.only);
            const testsToRun = onlyTests.length > 0 ? onlyTests : this.getAllTests();
            
            this.results.total = testsToRun.length;
            
            // Run global beforeAll hooks
            for (const hook of this.hooks.beforeAll) {
                await this.runHook(hook, 'beforeAll');
            }
            
            // Run tests
            if (this.config.parallel) {
                await this.runTestsParallel(testsToRun);
            } else {
                await this.runTestsSequential(testsToRun);
            }
            
            // Run global afterAll hooks
            for (const hook of this.hooks.afterAll) {
                await this.runHook(hook, 'afterAll');
            }
            
        } catch (error) {
            console.error('Test runner error:', error);
        }
        
        this.results.endTime = Date.now();
        this.results.duration = this.results.endTime - this.results.startTime;
        
        // Generate report
        this.generateReport();
        
        // Exit with appropriate code
        process.exit(this.results.failed > 0 ? 1 : 0);
    }

    getAllTests() {
        const tests = [...this.tests];
        
        for (const suite of this.suites.values()) {
            tests.push(...suite.tests);
        }
        
        return tests;
    }

    async runTestsSequential(tests) {
        for (const test of tests) {
            if (this.config.bail && this.results.failed > 0) break;
            await this.runTest(test);
        }
    }

    async runTestsParallel(tests) {
        const promises = tests.map(test => this.runTest(test));
        await Promise.allSettled(promises);
    }

    async runTest(test) {
        if (test.skip) {
            this.results.skipped++;
            if (this.config.verbose) {
                console.log(`⏭️  ${test.name}`);
            }
            return;
        }
        
        const start = performance.now();
        let error = null;
        
        try {
            // Run beforeEach hooks
            const beforeHooks = test.suite ? test.suite.beforeEach : this.hooks.beforeEach;
            for (const hook of beforeHooks) {
                await this.runHook(hook, 'beforeEach');
            }
            
            // Run test with timeout
            await this.runWithTimeout(test.fn, test.timeout);
            
            // Run afterEach hooks
            const afterHooks = test.suite ? test.suite.afterEach : this.hooks.afterEach;
            for (const hook of afterHooks) {
                await this.runHook(hook, 'afterEach');
            }
            
            this.results.passed++;
            
            if (this.config.verbose) {
                const duration = (performance.now() - start).toFixed(2);
                console.log(`✅ ${test.name} (${duration}ms)`);
            } else {
                process.stdout.write('.');
            }
            
        } catch (err) {
            error = err;
            this.results.failed++;
            this.results.failures.push({
                test: test.name,
                suite: test.suite?.name,
                error: err.message,
                stack: err.stack
            });
            
            if (this.config.verbose) {
                console.log(`❌ ${test.name}`);
                console.error(`   ${err.message}`);
            } else {
                process.stdout.write('F');
            }
        }
    }

    async runHook(hook, name) {
        try {
            await hook();
        } catch (error) {
            throw new Error(`${name} hook failed: ${error.message}`);
        }
    }

    async runWithTimeout(fn, timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Test timeout after ${timeout}ms`));
            }, timeout);
            
            Promise.resolve(fn())
                .then(resolve)
                .catch(reject)
                .finally(() => clearTimeout(timer));
        });
    }

    generateReport() {
        console.log('\n\n📊 Test Results:');
        console.log('================');
        console.log(`Total:   ${this.results.total}`);
        console.log(`Passed:  ${this.results.passed} ✅`);
        console.log(`Failed:  ${this.results.failed} ❌`);
        console.log(`Skipped: ${this.results.skipped} ⏭️`);
        console.log(`Duration: ${(this.results.duration / 1000).toFixed(2)}s`);
        
        if (this.results.failures.length > 0) {
            console.log('\n❌ Failures:');
            console.log('===========');
            
            this.results.failures.forEach((failure, index) => {
                console.log(`\n${index + 1}. ${failure.test}`);
                if (failure.suite) {
                    console.log(`   Suite: ${failure.suite}`);
                }
                console.log(`   Error: ${failure.error}`);
                if (this.config.verbose && failure.stack) {
                    console.log(`   Stack:\n${failure.stack.split('\n').map(l => '     ' + l).join('\n')}`);
                }
            });
        }
        
        const passRate = ((this.results.passed / this.results.total) * 100).toFixed(2);
        console.log(`\nPass Rate: ${passRate}%`);
        
        // Save report to file
        const reportPath = path.join(__dirname, '..', 'reports', `test-report-${Date.now()}.json`);
        fs.mkdir(path.dirname(reportPath), { recursive: true })
            .then(() => fs.writeFile(reportPath, JSON.stringify(this.results, null, 2)))
            .then(() => console.log(`\nReport saved to: ${reportPath}`))
            .catch(console.error);
    }
}

/**
 * Assertion class
 */
class Assertion {
    constructor(actual) {
        this.actual = actual;
        this.negative = false;
    }

    get not() {
        this.negative = true;
        return this;
    }

    toBe(expected) {
        const pass = Object.is(this.actual, expected);
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be ${expected}`
            );
        }
    }

    toEqual(expected) {
        const pass = this.deepEqual(this.actual, expected);
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${JSON.stringify(this.actual)} ${this.negative ? 'not ' : ''}to equal ${JSON.stringify(expected)}`
            );
        }
    }

    toBeNull() {
        const pass = this.actual === null;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be null`
            );
        }
    }

    toBeUndefined() {
        const pass = this.actual === undefined;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be undefined`
            );
        }
    }

    toBeTruthy() {
        const pass = !!this.actual;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be truthy`
            );
        }
    }

    toBeFalsy() {
        const pass = !this.actual;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be falsy`
            );
        }
    }

    toContain(item) {
        let pass = false;
        
        if (typeof this.actual === 'string') {
            pass = this.actual.includes(item);
        } else if (Array.isArray(this.actual)) {
            pass = this.actual.includes(item);
        } else if (this.actual instanceof Set || this.actual instanceof Map) {
            pass = this.actual.has(item);
        }
        
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to contain ${item}`
            );
        }
    }

    toHaveLength(length) {
        const actualLength = this.actual?.length ?? this.actual?.size ?? 0;
        const pass = actualLength === length;
        
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected length ${actualLength} ${this.negative ? 'not ' : ''}to be ${length}`
            );
        }
    }

    toThrow(expectedError) {
        let thrown = false;
        let actualError = null;
        
        try {
            if (typeof this.actual === 'function') {
                this.actual();
            }
        } catch (error) {
            thrown = true;
            actualError = error;
        }
        
        const pass = thrown && (!expectedError || actualError.message.includes(expectedError));
        
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected function ${this.negative ? 'not ' : ''}to throw${expectedError ? ` "${expectedError}"` : ''}`
            );
        }
    }

    toBeGreaterThan(value) {
        const pass = this.actual > value;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be greater than ${value}`
            );
        }
    }

    toBeLessThan(value) {
        const pass = this.actual < value;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be less than ${value}`
            );
        }
    }

    toBeInstanceOf(constructor) {
        const pass = this.actual instanceof constructor;
        if (this.negative ? pass : !pass) {
            throw new Error(
                `Expected ${this.actual} ${this.negative ? 'not ' : ''}to be instance of ${constructor.name}`
            );
        }
    }

    deepEqual(a, b) {
        if (a === b) return true;
        
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            if (a.constructor !== b.constructor) return false;
            
            if (Array.isArray(a)) {
                if (a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) {
                    if (!this.deepEqual(a[i], b[i])) return false;
                }
                return true;
            }
            
            const keys = Object.keys(a);
            if (keys.length !== Object.keys(b).length) return false;
            
            for (const key of keys) {
                if (!this.deepEqual(a[key], b[key])) return false;
            }
            
            return true;
        }
        
        return false;
    }
}

// Global test runner instance
const testRunner = new TestRunner();

// Export global functions
global.describe = testRunner.describe.bind(testRunner);
global.it = testRunner.it.bind(testRunner);
global.test = testRunner.it.bind(testRunner);
global.skip = testRunner.skip.bind(testRunner);
global.only = testRunner.only.bind(testRunner);
global.beforeAll = testRunner.beforeAll.bind(testRunner);
global.afterAll = testRunner.afterAll.bind(testRunner);
global.beforeEach = testRunner.beforeEach.bind(testRunner);
global.afterEach = testRunner.afterEach.bind(testRunner);
global.expect = testRunner.expect.bind(testRunner);

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    testRunner.run();
}

export default testRunner;