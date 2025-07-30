module.exports = {
    env: {
        node: true,
        es2021: true,
        jest: true
    },
    extends: [
        'eslint:recommended'
    ],
    parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module'
    },
    rules: {
        // エラー防止
        'no-unused-vars': ['error', { 
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_'
        }],
        'no-console': ['warn', { 
            allow: ['warn', 'error', 'info'] 
        }],
        'no-debugger': 'error',
        'no-dupe-keys': 'error',
        'no-duplicate-case': 'error',
        'no-empty': ['error', { 
            allowEmptyCatch: true 
        }],
        'no-extra-boolean-cast': 'error',
        'no-func-assign': 'error',
        'no-irregular-whitespace': 'error',
        'no-unreachable': 'error',
        'use-isnan': 'error',
        'valid-typeof': 'error',
        
        // ベストプラクティス
        'curly': ['error', 'all'],
        'dot-notation': 'error',
        'eqeqeq': ['error', 'always'],
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-loop-func': 'error',
        'no-multi-spaces': 'error',
        'no-multi-str': 'error',
        'no-new-func': 'error',
        'no-return-await': 'error',
        'no-script-url': 'error',
        'no-self-compare': 'error',
        'no-throw-literal': 'error',
        'no-useless-concat': 'error',
        'no-useless-return': 'error',
        'no-with': 'error',
        'prefer-promise-reject-errors': 'error',
        'radix': 'error',
        'require-await': 'error',
        
        // スタイル
        'array-bracket-spacing': ['error', 'never'],
        'block-spacing': ['error', 'always'],
        'brace-style': ['error', '1tbs', { 
            allowSingleLine: true 
        }],
        'comma-dangle': ['error', 'never'],
        'comma-spacing': ['error', { 
            before: false, 
            after: true 
        }],
        'comma-style': ['error', 'last'],
        'computed-property-spacing': ['error', 'never'],
        'consistent-this': ['error', 'self'],
        'func-call-spacing': ['error', 'never'],
        'indent': ['error', 4, { 
            SwitchCase: 1 
        }],
        'key-spacing': ['error', { 
            beforeColon: false, 
            afterColon: true 
        }],
        'keyword-spacing': ['error', { 
            before: true, 
            after: true 
        }],
        'linebreak-style': ['error', 'unix'],
        'max-len': ['warn', { 
            code: 120, 
            ignoreUrls: true,
            ignoreStrings: true,
            ignoreTemplateLiterals: true
        }],
        'no-mixed-spaces-and-tabs': 'error',
        'no-multiple-empty-lines': ['error', { 
            max: 2, 
            maxEOF: 1 
        }],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'quotes': ['error', 'single', { 
            avoidEscape: true 
        }],
        'semi': ['error', 'always'],
        'semi-spacing': ['error', { 
            before: false, 
            after: true 
        }],
        'space-before-blocks': ['error', 'always'],
        'space-before-function-paren': ['error', {
            anonymous: 'always',
            named: 'never',
            asyncArrow: 'always'
        }],
        'space-in-parens': ['error', 'never'],
        'space-infix-ops': 'error',
        'space-unary-ops': ['error', {
            words: true,
            nonwords: false
        }],
        
        // ES6+
        'arrow-spacing': ['error', { 
            before: true, 
            after: true 
        }],
        'no-duplicate-imports': 'error',
        'no-useless-computed-key': 'error',
        'no-useless-constructor': 'error',
        'no-var': 'error',
        'prefer-arrow-callback': ['error', {
            allowNamedFunctions: true
        }],
        'prefer-const': ['error', {
            destructuring: 'any',
            ignoreReadBeforeAssign: false
        }],
        'prefer-destructuring': ['warn', {
            array: true,
            object: true
        }],
        'prefer-rest-params': 'error',
        'prefer-spread': 'error',
        'prefer-template': 'error',
        'template-curly-spacing': ['error', 'never']
    }
};