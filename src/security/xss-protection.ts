/**
 * XSS Protection and Sanitization
 * Following Carmack/Martin/Pike principles:
 * - Simple and effective sanitization
 * - Context-aware escaping
 * - Performance-conscious implementation
 */

import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

interface SanitizeOptions {
  allowedTags?: string[];
  allowedAttributes?: string[];
  allowedSchemes?: string[];
  stripUnknown?: boolean;
  context?: 'html' | 'attribute' | 'url' | 'css' | 'javascript';
}

interface ValidationResult {
  safe: boolean;
  sanitized: string;
  violations: string[];
}

export class XSSProtection {
  private domPurify: any;
  private htmlEntityMap: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;'
  };

  constructor() {
    // Initialize DOMPurify with jsdom
    const window = new JSDOM('').window;
    this.domPurify = createDOMPurify(window as any);
    
    // Configure DOMPurify defaults
    this.configureDOMPurify();
  }

  /**
   * Configure DOMPurify with secure defaults
   */
  private configureDOMPurify(): void {
    // Add hooks for additional security
    this.domPurify.addHook('afterSanitizeAttributes', (node: any) => {
      // Remove any attribute starting with 'on'
      if (node.attributes) {
        for (let i = node.attributes.length - 1; i >= 0; i--) {
          const attr = node.attributes[i];
          if (attr.name.startsWith('on')) {
            node.removeAttribute(attr.name);
          }
        }
      }
      
      // Special handling for links
      if (node.tagName === 'A') {
        node.setAttribute('rel', 'noopener noreferrer');
        if (node.getAttribute('target') === '_blank') {
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
    });
  }

  /**
   * Sanitize input based on context
   */
  sanitize(input: any, options: SanitizeOptions = {}): string {
    // Handle non-string inputs
    if (input === null || input === undefined) {
      return '';
    }
    
    const stringInput = String(input);
    
    // Select sanitization method based on context
    switch (options.context) {
      case 'html':
        return this.sanitizeHTML(stringInput, options);
      case 'attribute':
        return this.sanitizeAttribute(stringInput);
      case 'url':
        return this.sanitizeURL(stringInput, options);
      case 'css':
        return this.sanitizeCSS(stringInput);
      case 'javascript':
        return this.sanitizeJavaScript(stringInput);
      default:
        return this.sanitizeGeneral(stringInput);
    }
  }

  /**
   * General purpose sanitization (default)
   */
  private sanitizeGeneral(input: string): string {
    // HTML entity encoding for general text
    return input.replace(/[&<>"'/]/g, char => this.htmlEntityMap[char]);
  }

  /**
   * Sanitize HTML content
   */
  private sanitizeHTML(input: string, options: SanitizeOptions): string {
    const config: any = {
      ALLOWED_TAGS: options.allowedTags || [
        'p', 'br', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'code', 'pre', 'em', 'strong', 'del', 'b', 'i', 'u',
        'a', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
      ],
      ALLOWED_ATTR: options.allowedAttributes || [
        'href', 'src', 'alt', 'title', 'class', 'id', 'style',
        'width', 'height', 'colspan', 'rowspan'
      ],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      KEEP_CONTENT: !options.stripUnknown,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
      RETURN_TRUSTED_TYPE: false
    };
    
    // Use DOMPurify for complex HTML sanitization
    return this.domPurify.sanitize(input, config);
  }

  /**
   * Sanitize HTML attributes
   */
  private sanitizeAttribute(input: string): string {
    // Remove any quotes and encode
    return input
      .replace(/["']/g, '')
      .replace(/[&<>]/g, char => this.htmlEntityMap[char]);
  }

  /**
   * Sanitize URLs
   */
  private sanitizeURL(input: string, options: SanitizeOptions): string {
    const allowedSchemes = options.allowedSchemes || ['http', 'https', 'mailto', 'tel'];
    
    try {
      const url = new URL(input);
      
      // Check if scheme is allowed
      if (!allowedSchemes.includes(url.protocol.replace(':', ''))) {
        return '';
      }
      
      // Additional checks for javascript: and data: URLs
      if (url.protocol === 'javascript:' || url.protocol === 'data:') {
        return '';
      }
      
      // Encode the URL
      return encodeURI(input);
    } catch {
      // If not a valid URL, encode as general text
      return this.sanitizeGeneral(input);
    }
  }

  /**
   * Sanitize CSS
   */
  private sanitizeCSS(input: string): string {
    // Remove any potential CSS injection vectors
    let sanitized = input;
    
    // Remove javascript: urls
    sanitized = sanitized.replace(/javascript:/gi, '');
    
    // Remove expression() calls (IE specific)
    sanitized = sanitized.replace(/expression\s*\(/gi, '');
    
    // Remove @import
    sanitized = sanitized.replace(/@import/gi, '');
    
    // Remove behavior property (IE specific)
    sanitized = sanitized.replace(/behavior\s*:/gi, '');
    
    // Remove -moz-binding (Firefox specific)
    sanitized = sanitized.replace(/-moz-binding\s*:/gi, '');
    
    // Encode remaining special characters
    return sanitized.replace(/[<>"']/g, char => this.htmlEntityMap[char]);
  }

  /**
   * Sanitize JavaScript string literals
   */
  private sanitizeJavaScript(input: string): string {
    // Escape for use in JavaScript string literals
    return input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\f/g, '\\f')
      .replace(/\v/g, '\\v')
      .replace(/\0/g, '\\0')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, (char) => {
        // Unicode escape for control characters
        return '\\u' + ('0000' + char.charCodeAt(0).toString(16)).slice(-4);
      });
  }

  /**
   * Validate and sanitize input with detailed results
   */
  validateAndSanitize(input: any, options: SanitizeOptions = {}): ValidationResult {
    const violations: string[] = [];
    const original = String(input);
    const sanitized = this.sanitize(input, options);
    
    // Check for common XSS patterns
    const xssPatterns = [
      { pattern: /<script/i, message: 'Script tag detected' },
      { pattern: /javascript:/i, message: 'JavaScript protocol detected' },
      { pattern: /on\w+\s*=/i, message: 'Event handler detected' },
      { pattern: /<iframe/i, message: 'Iframe tag detected' },
      { pattern: /<object/i, message: 'Object tag detected' },
      { pattern: /<embed/i, message: 'Embed tag detected' },
      { pattern: /eval\s*\(/i, message: 'Eval function detected' },
      { pattern: /expression\s*\(/i, message: 'CSS expression detected' },
      { pattern: /<img[^>]+src[\\s]*=[\\s]*["\']javascript:/i, message: 'JavaScript in image source' }
    ];
    
    for (const { pattern, message } of xssPatterns) {
      if (pattern.test(original)) {
        violations.push(message);
      }
    }
    
    const safe = violations.length === 0 && original === sanitized;
    
    return {
      safe,
      sanitized,
      violations
    };
  }

  /**
   * Create Content Security Policy header
   */
  generateCSPHeader(options: {
    reportUri?: string;
    upgradeInsecureRequests?: boolean;
    blockAllMixedContent?: boolean;
  } = {}): string {
    const directives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Tighten in production
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self' wss: https:",
      "media-src 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "manifest-src 'self'"
    ];
    
    if (options.upgradeInsecureRequests) {
      directives.push('upgrade-insecure-requests');
    }
    
    if (options.blockAllMixedContent) {
      directives.push('block-all-mixed-content');
    }
    
    if (options.reportUri) {
      directives.push(`report-uri ${options.reportUri}`);
    }
    
    return directives.join('; ');
  }

  /**
   * Sanitize JSON for safe embedding in HTML
   */
  sanitizeJSON(data: any): string {
    // Convert to JSON and escape for HTML context
    const json = JSON.stringify(data);
    
    // Escape HTML entities and Unicode characters
    return json
      .replace(/</g, '\\u003C')
      .replace(/>/g, '\\u003E')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  /**
   * Create safe HTML templates
   */
  createSafeTemplate(template: string, data: { [key: string]: any }): string {
    // Replace template variables with sanitized values
    return template.replace(/\{\{(\w+)(?::(\w+))?\}\}/g, (match, key, context) => {
      if (!(key in data)) {
        return '';
      }
      
      const value = data[key];
      const sanitizeContext = context || 'general';
      
      return this.sanitize(value, { context: sanitizeContext as any });
    });
  }
}

// Express middleware for XSS protection
export function xssProtectionMiddleware(xss: XSSProtection) {
  return (req: any, res: any, next: any) => {
    // Override res.send to automatically sanitize
    const originalSend = res.send;
    res.send = function(data: any) {
      if (typeof data === 'object') {
        // For JSON responses, ensure proper content type
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return originalSend.call(this, JSON.stringify(data));
      }
      return originalSend.call(this, data);
    };
    
    // Add CSP header
    const csp = xss.generateCSPHeader({
      reportUri: '/api/v1/security/csp-report'
    });
    res.setHeader('Content-Security-Policy', csp);
    
    // Add other security headers
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Sanitize request data
    if (req.body) {
      req.body = sanitizeObject(req.body, xss);
    }
    
    if (req.query) {
      req.query = sanitizeObject(req.query, xss);
    }
    
    if (req.params) {
      req.params = sanitizeObject(req.params, xss);
    }
    
    next();
  };
}

/**
 * Recursively sanitize object values
 */
function sanitizeObject(obj: any, xss: XSSProtection): any {
  if (typeof obj !== 'object' || obj === null) {
    return xss.sanitize(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, xss));
  }
  
  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    // Sanitize key as well to prevent prototype pollution
    const sanitizedKey = xss.sanitize(key, { context: 'attribute' });
    sanitized[sanitizedKey] = sanitizeObject(value, xss);
  }
  
  return sanitized;
}

// Export singleton instance
export const xssProtection = new XSSProtection();
