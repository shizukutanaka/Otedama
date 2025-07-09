// Custom ESLint rules for mining pool project
// Following John Carmack's principle: "Focus on what matters"

/**
 * Ensure proper error handling in async functions
 */
export const asyncErrorHandling = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure async functions have proper error handling',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
  },
  create(context: any) {
    return {
      AsyncFunction(node: any) {
        const bodyBlock = node.body;
        if (bodyBlock.type !== 'BlockStatement') return;

        const hasTryCatch = bodyBlock.body.some((statement: any) => 
          statement.type === 'TryStatement'
        );

        if (!hasTryCatch && node.parent.type !== 'TryStatement') {
          context.report({
            node,
            message: 'Async functions should have try-catch blocks for error handling',
          });
        }
      },
    };
  },
};

/**
 * Ensure Result type is used for operations that can fail
 */
export const useResultType = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Use Result<T> type for operations that can fail',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
  },
  create(context: any) {
    return {
      FunctionDeclaration(node: any) {
        if (!node.returnType) return;
        
        const returnTypeText = context.getSourceCode().getText(node.returnType);
        
        // Check if function name suggests it can fail
        const errorProneNames = ['validate', 'parse', 'process', 'send', 'fetch', 'load', 'save'];
        const functionName = node.id?.name || '';
        
        const isErrorProne = errorProneNames.some(name => 
          functionName.toLowerCase().includes(name)
        );
        
        if (isErrorProne && !returnTypeText.includes('Result<')) {
          context.report({
            node: node.returnType,
            message: `Consider using Result<T> type for ${functionName} as it may fail`,
          });
        }
      },
    };
  },
};

/**
 * Ensure proper Bitcoin address validation
 */
export const bitcoinAddressValidation = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure Bitcoin addresses are properly validated',
      category: 'Security',
      recommended: true,
    },
    schema: [],
  },
  create(context: any) {
    return {
      AssignmentExpression(node: any) {
        const sourceCode = context.getSourceCode();
        const text = sourceCode.getText(node);
        
        // Check if assigning to something that looks like an address
        if (text.includes('address') || text.includes('Address')) {
          const rightText = sourceCode.getText(node.right);
          
          // Check if the right side is a string literal without validation
          if (node.right.type === 'Literal' && typeof node.right.value === 'string') {
            context.report({
              node,
              message: 'Bitcoin addresses should be validated before assignment',
            });
          }
        }
      },
    };
  },
};

/**
 * Ensure proper cleanup in classes with resources
 */
export const resourceCleanup = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure classes with resources have cleanup methods',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
  },
  create(context: any) {
    return {
      ClassDeclaration(node: any) {
        const hasResources = node.body.body.some((member: any) => {
          if (member.type !== 'PropertyDefinition') return false;
          
          const name = member.key?.name || '';
          return ['connection', 'socket', 'server', 'client', 'stream'].some(resource =>
            name.toLowerCase().includes(resource)
          );
        });
        
        if (hasResources) {
          const hasCleanup = node.body.body.some((member: any) => {
            if (member.type !== 'MethodDefinition') return false;
            
            const name = member.key?.name || '';
            return ['dispose', 'cleanup', 'close', 'stop', 'destroy'].includes(name);
          });
          
          if (!hasCleanup) {
            context.report({
              node,
              message: 'Classes with resources should have cleanup methods (dispose, close, stop)',
            });
          }
        }
      },
    };
  },
};

/**
 * Ensure consistent logger usage
 */
export const consistentLogger = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Use logger instead of console',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
  },
  create(context: any) {
    return {
      MemberExpression(node: any) {
        if (node.object.name === 'console') {
          const method = node.property.name;
          
          const loggerMethod = {
            log: 'info',
            error: 'error',
            warn: 'warn',
            info: 'info',
            debug: 'debug',
          }[method];
          
          if (loggerMethod) {
            context.report({
              node,
              message: `Use logger.${loggerMethod}() instead of console.${method}()`,
            });
          }
        }
      },
    };
  },
};

/**
 * Ensure proper decimal handling for Bitcoin amounts
 */
export const decimalPrecision = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure proper decimal precision for Bitcoin amounts',
      category: 'Correctness',
      recommended: true,
    },
    schema: [],
  },
  create(context: any) {
    return {
      BinaryExpression(node: any) {
        const sourceCode = context.getSourceCode();
        const parent = node.parent;
        
        // Check if this looks like a Bitcoin calculation
        const text = sourceCode.getText(parent);
        const isBitcoinRelated = ['btc', 'bitcoin', 'amount', 'balance', 'fee', 'payout'].some(
          keyword => text.toLowerCase().includes(keyword)
        );
        
        if (isBitcoinRelated && node.operator === '/') {
          // Check if dividing by a power of 10
          if (node.right.type === 'Literal' && 
              typeof node.right.value === 'number' &&
              [10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000].includes(node.right.value)) {
            context.report({
              node,
              message: 'Use BigInt or decimal library for Bitcoin amount calculations to avoid precision loss',
            });
          }
        }
      },
    };
  },
};

// Export all rules
export const rules = {
  'async-error-handling': asyncErrorHandling,
  'use-result-type': useResultType,
  'bitcoin-address-validation': bitcoinAddressValidation,
  'resource-cleanup': resourceCleanup,
  'consistent-logger': consistentLogger,
  'decimal-precision': decimalPrecision,
};

// Export plugin
export default {
  rules,
};
