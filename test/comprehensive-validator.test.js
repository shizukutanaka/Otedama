/**
 * Unit tests for ComprehensiveValidator
 * Tests validation rules, security features, and performance
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { 
  ComprehensiveValidator, 
  getValidator, 
  ValidationError, 
  ValidationResult,
  ValidationErrorType,
  CommonSchemas 
} from '../lib/validation/comprehensive-validator.js';

describe('ComprehensiveValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new ComprehensiveValidator({
      enableSecurityValidation: true,
      enableTimingSafeComparison: true
    });
  });

  afterEach(() => {
    validator.resetStats();
  });

  describe('ValidationResult', () => {
    it('should initialize correctly', () => {
      const result = new ValidationResult();
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.an('array').that.is.empty;
      expect(result.warnings).to.be.an('array').that.is.empty;
    });

    it('should add errors correctly', () => {
      const result = new ValidationResult();
      result.addError('testField', ValidationErrorType.REQUIRED, 'Field is required');
      
      expect(result.valid).to.be.false;
      expect(result.hasErrors()).to.be.true;
      expect(result.errors).to.have.lengthOf(1);
      expect(result.getFirstError().field).to.equal('testField');
    });

    it('should filter errors by field', () => {
      const result = new ValidationResult();
      result.addError('field1', ValidationErrorType.REQUIRED, 'Error 1');
      result.addError('field2', ValidationErrorType.TYPE, 'Error 2');
      result.addError('field1', ValidationErrorType.LENGTH, 'Error 3');
      
      const field1Errors = result.getFieldErrors('field1');
      expect(field1Errors).to.have.lengthOf(2);
      expect(field1Errors[0].type).to.equal(ValidationErrorType.REQUIRED);
      expect(field1Errors[1].type).to.equal(ValidationErrorType.LENGTH);
    });
  });

  describe('Basic Validation', () => {
    it('should validate required fields', () => {
      const result = validator.validateValue(null, { required: true }, 'testField');
      expect(result.hasErrors()).to.be.true;
      expect(result.getFirstError().type).to.equal(ValidationErrorType.REQUIRED);
    });

    it('should skip validation for non-required empty values', () => {
      const result = validator.validateValue(null, { required: false, minLength: 5 }, 'testField');
      expect(result.hasErrors()).to.be.false;
    });

    it('should validate types correctly', () => {
      const stringResult = validator.validateValue('test', { type: 'string' });
      expect(stringResult.hasErrors()).to.be.false;
      
      const numberResult = validator.validateValue('test', { type: 'number' });
      expect(numberResult.hasErrors()).to.be.true;
      expect(numberResult.getFirstError().type).to.equal(ValidationErrorType.TYPE);
    });

    it('should allow string numbers for numeric type', () => {
      const result = validator.validateValue('123', { type: 'number' });
      expect(result.hasErrors()).to.be.false;
    });
  });

  describe('String Validation', () => {
    it('should validate string length', () => {
      const shortResult = validator.validateValue('ab', { minLength: 3 });
      expect(shortResult.hasErrors()).to.be.true;
      expect(shortResult.getFirstError().type).to.equal(ValidationErrorType.LENGTH);
      
      const longResult = validator.validateValue('toolongstring', { maxLength: 5 });
      expect(longResult.hasErrors()).to.be.true;
      expect(longResult.getFirstError().type).to.equal(ValidationErrorType.LENGTH);
      
      const validResult = validator.validateValue('perfect', { minLength: 3, maxLength: 10 });
      expect(validResult.hasErrors()).to.be.false;
    });

    it('should validate patterns', () => {
      const emailPattern = /^[^@]+@[^@]+\.[^@]+$/;
      
      const validEmail = validator.validateValue('test@example.com', { pattern: emailPattern });
      expect(validEmail.hasErrors()).to.be.false;
      
      const invalidEmail = validator.validateValue('invalid-email', { pattern: emailPattern });
      expect(invalidEmail.hasErrors()).to.be.true;
      expect(invalidEmail.getFirstError().type).to.equal(ValidationErrorType.FORMAT);
    });

    it('should validate predefined formats', () => {
      const validEmail = validator.validateValue('user@domain.com', { format: 'email' });
      expect(validEmail.hasErrors()).to.be.false;
      
      const invalidEmail = validator.validateValue('not-an-email', { format: 'email' });
      expect(invalidEmail.hasErrors()).to.be.true;
      
      const validUsername = validator.validateValue('user123', { format: 'username' });
      expect(validUsername.hasErrors()).to.be.false;
      
      const invalidUsername = validator.validateValue('user with spaces', { format: 'username' });
      expect(invalidUsername.hasErrors()).to.be.true;
    });

    it('should validate enum values', () => {
      const validEnum = validator.validateValue('option1', { enum: ['option1', 'option2', 'option3'] });
      expect(validEnum.hasErrors()).to.be.false;
      
      const invalidEnum = validator.validateValue('invalid', { enum: ['option1', 'option2', 'option3'] });
      expect(invalidEnum.hasErrors()).to.be.true;
      expect(invalidEnum.getFirstError().type).to.equal(ValidationErrorType.RANGE);
    });

    it('should validate cryptocurrency addresses', () => {
      // Valid Bitcoin address
      const validBTC = validator.validateValue('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', { cryptoAddress: 'BTC' });
      expect(validBTC.hasErrors()).to.be.false;
      
      // Invalid Bitcoin address
      const invalidBTC = validator.validateValue('invalid-btc-address', { cryptoAddress: 'BTC' });
      expect(invalidBTC.hasErrors()).to.be.true;
      
      // Valid Ethereum address
      const validETH = validator.validateValue('0x742d35Cc6635C0532925a3b8D26c8126fFE1cd0c', { cryptoAddress: 'ETH' });
      expect(validETH.hasErrors()).to.be.false;
    });

    it('should enforce global max string length', () => {
      const validator = new ComprehensiveValidator({ maxStringLength: 10 });
      const result = validator.validateValue('a'.repeat(20), {});
      expect(result.hasErrors()).to.be.true;
      expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
    });
  });

  describe('Number Validation', () => {
    it('should validate number ranges', () => {
      const tooSmall = validator.validateValue(5, { min: 10 });
      expect(tooSmall.hasErrors()).to.be.true;
      expect(tooSmall.getFirstError().type).to.equal(ValidationErrorType.RANGE);
      
      const tooBig = validator.validateValue(15, { max: 10 });
      expect(tooBig.hasErrors()).to.be.true;
      expect(tooBig.getFirstError().type).to.equal(ValidationErrorType.RANGE);
      
      const valid = validator.validateValue(7, { min: 5, max: 10 });
      expect(valid.hasErrors()).to.be.false;
    });

    it('should validate integer requirement', () => {
      const validInteger = validator.validateValue(42, { integer: true });
      expect(validInteger.hasErrors()).to.be.false;
      
      const invalidInteger = validator.validateValue(42.5, { integer: true });
      expect(invalidInteger.hasErrors()).to.be.true;
      expect(invalidInteger.getFirstError().type).to.equal(ValidationErrorType.TYPE);
    });

    it('should validate positive numbers', () => {
      const positive = validator.validateValue(5, { positive: true });
      expect(positive.hasErrors()).to.be.false;
      
      const zero = validator.validateValue(0, { positive: true });
      expect(zero.hasErrors()).to.be.true;
      
      const negative = validator.validateValue(-5, { positive: true });
      expect(negative.hasErrors()).to.be.true;
    });

    it('should validate non-negative numbers', () => {
      const positive = validator.validateValue(5, { nonNegative: true });
      expect(positive.hasErrors()).to.be.false;
      
      const zero = validator.validateValue(0, { nonNegative: true });
      expect(zero.hasErrors()).to.be.false;
      
      const negative = validator.validateValue(-5, { nonNegative: true });
      expect(negative.hasErrors()).to.be.true;
    });

    it('should validate decimal precision', () => {
      const valid = validator.validateValue(123.45, { precision: 2 });
      expect(valid.hasErrors()).to.be.false;
      
      const invalid = validator.validateValue(123.456, { precision: 2 });
      expect(invalid.hasErrors()).to.be.true;
      expect(invalid.getFirstError().type).to.equal(ValidationErrorType.FORMAT);
    });
  });

  describe('Array Validation', () => {
    it('should validate array length', () => {
      const tooShort = validator.validateValue([1, 2], { minItems: 3 });
      expect(tooShort.hasErrors()).to.be.true;
      expect(tooShort.getFirstError().type).to.equal(ValidationErrorType.LENGTH);
      
      const tooLong = validator.validateValue([1, 2, 3, 4, 5], { maxItems: 3 });
      expect(tooLong.hasErrors()).to.be.true;
      
      const valid = validator.validateValue([1, 2, 3], { minItems: 2, maxItems: 5 });
      expect(valid.hasErrors()).to.be.false;
    });

    it('should validate array items', () => {
      const result = validator.validateValue(['valid', 123, 'string'], { 
        items: { type: 'string' } 
      });
      expect(result.hasErrors()).to.be.true;
      // Should have error for the number item
      expect(result.errors.some(e => e.field.includes('[1]'))).to.be.true;
    });

    it('should validate unique items', () => {
      const duplicates = validator.validateValue([1, 2, 3, 2], { uniqueItems: true });
      expect(duplicates.hasErrors()).to.be.true;
      expect(duplicates.getFirstError().type).to.equal(ValidationErrorType.BUSINESS_RULE);
      
      const unique = validator.validateValue([1, 2, 3, 4], { uniqueItems: true });
      expect(unique.hasErrors()).to.be.false;
    });

    it('should enforce global max array length', () => {
      const validator = new ComprehensiveValidator({ maxArrayLength: 5 });
      const result = validator.validateValue(Array(10).fill(1), {});
      expect(result.hasErrors()).to.be.true;
      expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
    });
  });

  describe('Object Validation', () => {
    it('should validate object schema', () => {
      const schema = {
        name: { type: 'string', required: true },
        age: { type: 'number', min: 0, max: 150 },
        email: { type: 'string', format: 'email' }
      };
      
      const validObj = {
        name: 'John',
        age: 30,
        email: 'john@example.com'
      };
      
      const result = validator.validateObject(validObj, schema);
      expect(result.hasErrors()).to.be.false;
      
      const invalidObj = {
        age: -5,
        email: 'not-an-email'
      };
      
      const invalidResult = validator.validateObject(invalidObj, schema);
      expect(invalidResult.hasErrors()).to.be.true;
      expect(invalidResult.errors.some(e => e.field === 'name')).to.be.true; // Missing required
      expect(invalidResult.errors.some(e => e.field === 'age')).to.be.true;   // Invalid range
      expect(invalidResult.errors.some(e => e.field === 'email')).to.be.true; // Invalid format
    });

    it('should handle strict mode', () => {
      const schema = {
        name: { type: 'string', required: true },
        age: { type: 'number' },
        _strictMode: true
      };
      
      const objWithExtra = {
        name: 'John',
        age: 30,
        extra: 'unexpected field'
      };
      
      const result = validator.validateObject(objWithExtra, schema);
      expect(result.hasErrors()).to.be.true;
      expect(result.errors.some(e => e.message.includes('Unexpected fields'))).to.be.true;
    });

    it('should prevent deep nesting attacks', () => {
      const validator = new ComprehensiveValidator({ maxObjectDepth: 3 });
      
      const deepObj = { a: { b: { c: { d: 'too deep' } } } };
      const result = validator.validateObject(deepObj, {});
      expect(result.hasErrors()).to.be.true;
      expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
    });
  });

  describe('Security Validation', () => {
    it('should detect SQL injection patterns', () => {
      const maliciousInputs = [
        "'; DROP TABLE users; --",
        "1' OR '1'='1",
        "UNION SELECT * FROM passwords",
        "admin'/*"
      ];
      
      maliciousInputs.forEach(input => {
        const result = validator.validateValue(input, {});
        expect(result.hasErrors()).to.be.true;
        expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
        expect(result.getFirstError().message).to.include('SQL injection');
      });
    });

    it('should detect XSS patterns', () => {
      const xssInputs = [
        '<script>alert("xss")</script>',
        '<iframe src="javascript:alert(1)"></iframe>',
        'javascript:alert(1)',
        '<img onerror="alert(1)" src="x">',
        'onload=alert(1)'
      ];
      
      xssInputs.forEach(input => {
        const result = validator.validateValue(input, {});
        expect(result.hasErrors()).to.be.true;
        expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
        expect(result.getFirstError().message).to.include('XSS');
      });
    });

    it('should detect path traversal patterns', () => {
      const pathTraversalInputs = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        '..%2f..%2fetc%2fpasswd',
        '..%5c..%5cwindows%5csystem32'
      ];
      
      pathTraversalInputs.forEach(input => {
        const result = validator.validateValue(input, {});
        expect(result.hasErrors()).to.be.true;
        expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
        expect(result.getFirstError().message).to.include('path traversal');
      });
    });

    it('should detect excessive control characters', () => {
      const controlChars = '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09'; // 10 control chars
      const input = 'abc' + controlChars; // 13 chars total, 10/13 = 77% control chars
      
      const result = validator.validateValue(input, {});
      expect(result.hasErrors()).to.be.true;
      expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
      expect(result.getFirstError().message).to.include('control characters');
    });

    it('should allow disabling security validation', () => {
      const insecureValidator = new ComprehensiveValidator({ enableSecurityValidation: false });
      const result = insecureValidator.validateValue('<script>alert("xss")</script>', {});
      expect(result.hasErrors()).to.be.false;
    });
  });

  describe('Custom Validation', () => {
    it('should support custom validation functions', () => {
      const customRule = (value) => {
        return value % 2 === 0 || 'Must be even number';
      };
      
      const validResult = validator.validateValue(4, { custom: customRule });
      expect(validResult.hasErrors()).to.be.false;
      
      const invalidResult = validator.validateValue(5, { custom: customRule });
      expect(invalidResult.hasErrors()).to.be.true;
      expect(invalidResult.getFirstError().message).to.equal('Must be even number');
    });

    it('should handle custom validation exceptions', () => {
      const throwingRule = () => {
        throw new Error('Custom validation error');
      };
      
      const result = validator.validateValue('test', { custom: throwingRule });
      expect(result.hasErrors()).to.be.true;
      expect(result.getFirstError().type).to.equal(ValidationErrorType.BUSINESS_RULE);
    });
  });

  describe('Input Sanitization', () => {
    it('should sanitize HTML by default', () => {
      const input = '<script>alert("xss")</script><p>Hello</p>';
      const sanitized = validator.sanitize(input);
      expect(sanitized).to.not.include('<script>');
      expect(sanitized).to.not.include('<p>');
    });

    it('should escape HTML characters', () => {
      const input = '<>&"\'';
      const sanitized = validator.sanitize(input, { stripHtml: false, escapeHtml: true });
      expect(sanitized).to.equal('&lt;&gt;&amp;&quot;&#x27;');
    });

    it('should remove control characters', () => {
      const input = 'Hello\x00\x01\x02World';
      const sanitized = validator.sanitize(input);
      expect(sanitized).to.equal('HelloWorld');
    });

    it('should normalize whitespace', () => {
      const input = '  Hello    World  \t\n  ';
      const sanitized = validator.sanitize(input);
      expect(sanitized).to.equal('Hello World');
    });

    it('should allow customizing sanitization options', () => {
      const input = '<b>Bold</b>  text  ';
      const sanitized = validator.sanitize(input, {
        stripHtml: false,
        escapeHtml: false,
        normalizeWhitespace: false
      });
      expect(sanitized).to.equal('<b>Bold</b>  text  ');
    });
  });

  describe('Timing-Safe Comparison', () => {
    it('should perform timing-safe string comparison', () => {
      expect(validator.timingSafeStringEqual('hello', 'hello')).to.be.true;
      expect(validator.timingSafeStringEqual('hello', 'world')).to.be.false;
    });

    it('should handle different string lengths', () => {
      expect(validator.timingSafeStringEqual('short', 'very long string')).to.be.false;
    });

    it('should be timing attack resistant', () => {
      const base = 'a'.repeat(1000);
      const different1 = 'b' + 'a'.repeat(999);  // Different at start
      const different2 = 'a'.repeat(999) + 'b';  // Different at end
      
      const iterations = 100;
      
      let startTime = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        validator.timingSafeStringEqual(base, different1);
      }
      const time1 = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        validator.timingSafeStringEqual(base, different2);
      }
      const time2 = process.hrtime.bigint();
      
      const timeDiff = Number(time2 - time1) / 1000000; // Convert to milliseconds
      expect(Math.abs(timeDiff)).to.be.below(10); // Should be within 10ms
    });

    it('should allow disabling timing-safe comparison', () => {
      const validator = new ComprehensiveValidator({ enableTimingSafeComparison: false });
      expect(validator.timingSafeStringEqual('hello', 'hello')).to.be.true;
      expect(validator.timingSafeStringEqual('hello', 'world')).to.be.false;
    });
  });

  describe('Performance Tracking', () => {
    it('should track validation statistics', () => {
      validator.validateValue('test', { type: 'string' });
      validator.validateValue('invalid', { type: 'number' });
      validator.validateValue('malicious<script>', {});
      
      const stats = validator.getStats();
      expect(stats).to.have.property('validations');
      expect(stats).to.have.property('errors');
      expect(stats).to.have.property('securityIssues');
      expect(stats).to.have.property('averageTime');
      expect(stats.validations).to.equal(3);
      expect(stats.errors).to.equal(2); // One type error, one security error
      expect(stats.securityIssues).to.equal(1);
    });

    it('should calculate rates correctly', () => {
      for (let i = 0; i < 10; i++) {
        validator.validateValue('test', { type: 'string' }); // Valid
      }
      for (let i = 0; i < 5; i++) {
        validator.validateValue('test', { type: 'number' }); // Invalid
      }
      
      const stats = validator.getStats();
      expect(stats.errorRate).to.be.closeTo(5/15, 0.01); // 5 errors out of 15 validations
    });

    it('should reset statistics', () => {
      validator.validateValue('test', { type: 'string' });
      validator.resetStats();
      
      const stats = validator.getStats();
      expect(stats.validations).to.equal(0);
      expect(stats.errors).to.equal(0);
      expect(stats.averageTime).to.equal(0);
    });
  });

  describe('Common Schemas', () => {
    it('should validate user schema', () => {
      const validUser = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'SecurePass123!'
      };
      
      const result = validator.validateObject(validUser, CommonSchemas.user);
      expect(result.hasErrors()).to.be.false;
      
      const invalidUser = {
        username: 'ab', // Too short
        email: 'invalid-email',
        password: 'weak'
      };
      
      const invalidResult = validator.validateObject(invalidUser, CommonSchemas.user);
      expect(invalidResult.hasErrors()).to.be.true;
      expect(invalidResult.errors.length).to.be.greaterThan(1);
    });

    it('should validate order schema', () => {
      const validOrder = {
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        quantity: 1.5,
        price: 50000.00
      };
      
      const result = validator.validateObject(validOrder, CommonSchemas.order);
      expect(result.hasErrors()).to.be.false;
      
      const invalidOrder = {
        symbol: 'invalid-symbol',
        side: 'invalid-side',
        type: 'invalid-type',
        quantity: -1,
        price: -100
      };
      
      const invalidResult = validator.validateObject(invalidOrder, CommonSchemas.order);
      expect(invalidResult.hasErrors()).to.be.true;
    });

    it('should validate wallet address schema', () => {
      const validWallet = {
        address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        currency: 'BTC'
      };
      
      const result = validator.validateObject(validWallet, CommonSchemas.walletAddress);
      expect(result.hasErrors()).to.be.false;
    });
  });
});

describe('Validator Singleton', () => {
  it('should return same instance', () => {
    const validator1 = getValidator();
    const validator2 = getValidator();
    expect(validator1).to.equal(validator2);
  });

  it('should maintain configuration', () => {
    const validator = getValidator({ enableSecurityValidation: false });
    const result = validator.validateValue('<script>alert("xss")</script>', {});
    expect(result.hasErrors()).to.be.false; // Security validation disabled
  });
});

describe('Error Handling', () => {
  it('should handle malformed input gracefully', () => {
    const validator = new ComprehensiveValidator();
    
    expect(() => {
      validator.validateValue(undefined, null);
      validator.validateValue(Symbol('test'), {});
      validator.validateObject(null, {});
    }).to.not.throw();
  });

  it('should handle circular references', () => {
    const validator = new ComprehensiveValidator();
    const circular = { name: 'test' };
    circular.self = circular;
    
    expect(() => {
      validator.validateObject(circular, { name: { type: 'string' } });
    }).to.not.throw();
  });

  it('should prevent stack overflow with deep nesting', () => {
    const validator = new ComprehensiveValidator({ maxObjectDepth: 100 });
    
    // Create deeply nested object
    let deep = {};
    let current = deep;
    for (let i = 0; i < 150; i++) {
      current.next = {};
      current = current.next;
    }
    
    const result = validator.validateObject(deep, {});
    expect(result.hasErrors()).to.be.true;
    expect(result.getFirstError().type).to.equal(ValidationErrorType.SECURITY);
  });
});