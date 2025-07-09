/**
 * Validation system tests
 */

import { commonSchemas, poolSchemas, validateRequest, validateQuery, validate, customValidators } from '../validation';
import { Request, Response, NextFunction } from 'express';

// Mock Express request/response
const mockRequest = (overrides?: any): Request => ({
  body: {},
  params: {},
  query: {},
  headers: {},
  ...overrides
} as Request);

const mockResponse = (): Response => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockNext: NextFunction = jest.fn();

describe('Validation System', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('Common Schemas', () => {
    describe('bitcoinAddress', () => {
      it('should validate valid P2PKH addresses', () => {
        const validAddresses = [
          '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
          '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
        ];
        
        validAddresses.forEach(address => {
          expect(commonSchemas.bitcoinAddress.safeParse(address).success).toBe(true);
        });
      });
      
      it('should validate valid Bech32 addresses', () => {
        const validAddresses = [
          'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'
        ];
        
        validAddresses.forEach(address => {
          expect(commonSchemas.bitcoinAddress.safeParse(address).success).toBe(true);
        });
      });
      
      it('should reject invalid Bitcoin addresses', () => {
        const invalidAddresses = [
          'invalid',
          '1234567890',
          '0x742d35Cc6634C0532925a3b844Bc9e7595f06fEc', // Ethereum address
          ''
        ];
        
        invalidAddresses.forEach(address => {
          expect(commonSchemas.bitcoinAddress.safeParse(address).success).toBe(false);
        });
      });
    });
    
    describe('ethereumAddress', () => {
      it('should validate valid Ethereum addresses', () => {
        const validAddresses = [
          '0x742d35Cc6634C0532925a3b844Bc9e7595f06fEc',
          '0x0000000000000000000000000000000000000000'
        ];
        
        validAddresses.forEach(address => {
          expect(commonSchemas.ethereumAddress.safeParse(address).success).toBe(true);
        });
      });
      
      it('should reject invalid Ethereum addresses', () => {
        const invalidAddresses = [
          '742d35Cc6634C0532925a3b844Bc9e7595f06fEc', // Missing 0x
          '0x742d35Cc6634C0532925a3b844Bc9e7595f06fE', // Wrong length
          '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', // Invalid characters
          'invalid'
        ];
        
        invalidAddresses.forEach(address => {
          expect(commonSchemas.ethereumAddress.safeParse(address).success).toBe(false);
        });
      });
    });
    
    describe('email', () => {
      it('should validate valid email addresses', () => {
        const validEmails = [
          'test@example.com',
          'user.name@domain.co.uk',
          'user+tag@example.org'
        ];
        
        validEmails.forEach(email => {
          expect(commonSchemas.email.safeParse(email).success).toBe(true);
        });
      });
      
      it('should reject invalid email addresses', () => {
        const invalidEmails = [
          'invalid',
          '@example.com',
          'user@',
          'user @example.com'
        ];
        
        invalidEmails.forEach(email => {
          expect(commonSchemas.email.safeParse(email).success).toBe(false);
        });
      });
    });
    
    describe('password', () => {
      it('should validate strong passwords', () => {
        const validPasswords = [
          'Password123!',
          'StrongP@ss1',
          'C0mpl3x!Pass'
        ];
        
        validPasswords.forEach(password => {
          expect(commonSchemas.password.safeParse(password).success).toBe(true);
        });
      });
      
      it('should reject weak passwords', () => {
        const invalidPasswords = [
          'short', // Too short
          'password123', // No uppercase
          'PASSWORD123', // No lowercase
          'Password', // No number
          'Password123' // No special character
        ];
        
        invalidPasswords.forEach(password => {
          expect(commonSchemas.password.safeParse(password).success).toBe(false);
        });
      });
    });
    
    describe('cryptoAmount', () => {
      it('should validate valid crypto amounts', () => {
        const validAmounts = [
          0.00000001, // 1 satoshi
          1.0,
          21000000, // Max Bitcoin supply
          0.12345678 // 8 decimals
        ];
        
        validAmounts.forEach(amount => {
          expect(commonSchemas.cryptoAmount.safeParse(amount).success).toBe(true);
        });
      });
      
      it('should reject invalid crypto amounts', () => {
        const invalidAmounts = [
          0, // Not positive
          -1, // Negative
          0.123456789 // Too many decimals
        ];
        
        invalidAmounts.forEach(amount => {
          expect(commonSchemas.cryptoAmount.safeParse(amount).success).toBe(false);
        });
      });
    });
  });
  
  describe('Pool Schemas', () => {
    describe('minerAuth', () => {
      it('should validate valid miner auth', () => {
        const validAuth = {
          address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
          signature: 'validSignature',
          message: 'optional message',
          timestamp: Date.now()
        };
        
        expect(poolSchemas.minerAuth.safeParse(validAuth).success).toBe(true);
      });
      
      it('should require address and signature', () => {
        const invalidAuth = {
          address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
        };
        
        expect(poolSchemas.minerAuth.safeParse(invalidAuth).success).toBe(false);
      });
    });
    
    describe('withdrawal', () => {
      it('should validate valid withdrawal request', () => {
        const validWithdrawal = {
          amount: 0.01,
          address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          otp: '123456'
        };
        
        expect(poolSchemas.withdrawal.safeParse(validWithdrawal).success).toBe(true);
      });
      
      it('should validate withdrawal without OTP', () => {
        const validWithdrawal = {
          amount: 0.01,
          address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
        };
        
        expect(poolSchemas.withdrawal.safeParse(validWithdrawal).success).toBe(true);
      });
      
      it('should reject invalid OTP length', () => {
        const invalidWithdrawal = {
          amount: 0.01,
          address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          otp: '12345' // Too short
        };
        
        expect(poolSchemas.withdrawal.safeParse(invalidWithdrawal).success).toBe(false);
      });
    });
  });
  
  describe('Middleware', () => {
    describe('validateRequest', () => {
      it('should pass valid request body', async () => {
        const schema = poolSchemas.minerAuth;
        const middleware = validateRequest(schema);
        
        const req = mockRequest({
          body: {
            address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            signature: 'validSignature'
          }
        });
        const res = mockResponse();
        
        await middleware(req, res, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });
      
      it('should reject invalid request body', async () => {
        const schema = poolSchemas.minerAuth;
        const middleware = validateRequest(schema);
        
        const req = mockRequest({
          body: {
            address: 'invalid-address',
            signature: 'validSignature'
          }
        });
        const res = mockResponse();
        
        await middleware(req, res, mockNext);
        
        expect(mockNext).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'Validation Error'
          })
        );
      });
    });
    
    describe('validateQuery', () => {
      it('should parse and validate query parameters', async () => {
        const schema = poolSchemas.poolStatsQuery;
        const middleware = validateQuery(schema);
        
        const req = mockRequest({
          query: {
            period: '24h',
            interval: '1h'
          }
        });
        const res = mockResponse();
        
        await middleware(req, res, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(req.query.period).toBe('24h');
      });
      
      it('should apply default values', async () => {
        const schema = poolSchemas.poolStatsQuery;
        const middleware = validateQuery(schema);
        
        const req = mockRequest({
          query: {}
        });
        const res = mockResponse();
        
        await middleware(req, res, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(req.query.period).toBe('24h');
      });
    });
    
    describe('validate (combined)', () => {
      it('should validate multiple parts of request', async () => {
        const middleware = validate({
          body: poolSchemas.minerAuth,
          query: poolSchemas.poolStatsQuery
        });
        
        const req = mockRequest({
          body: {
            address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            signature: 'validSignature'
          },
          query: {
            period: '7d'
          }
        });
        const res = mockResponse();
        
        await middleware(req, res, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(req.body.address).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
        expect(req.query.period).toBe('7d');
      });
    });
  });
  
  describe('Custom Validators', () => {
    describe('sanitize', () => {
      it('should strip HTML tags', () => {
        const input = '<script>alert("xss")</script>Hello<br>World';
        const sanitized = customValidators.sanitize.stripHtml(input);
        
        expect(sanitized).toBe('HelloWorld');
      });
      
      it('should escape HTML entities', () => {
        const input = '<script>alert("xss")</script>';
        const escaped = customValidators.sanitize.escapeHtml(input);
        
        expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;');
      });
      
      it('should normalize whitespace', () => {
        const input = '  Hello   World  \n\t Test  ';
        const normalized = customValidators.sanitize.normalizeWhitespace(input);
        
        expect(normalized).toBe('Hello World Test');
      });
      
      it('should convert to safe filename', () => {
        const input = 'File Name with $pecial Ch@rs!.txt';
        const safe = customValidators.sanitize.toSafeFilename(input);
        
        expect(safe).toBe('File_Name_with_pecial_Ch_rs_.txt');
      });
    });
  });
});
