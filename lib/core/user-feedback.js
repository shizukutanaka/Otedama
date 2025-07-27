/**
 * User Feedback System - Otedama
 * Improved error messages and user notifications
 * 
 * Design principles:
 * - Clear, actionable error messages
 * - Contextual help and suggestions
 * - Non-technical user-friendly language
 * - Consistent tone and formatting
 */

import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('UserFeedback');

/**
 * Message types
 */
export const MessageType = {
  SUCCESS: 'success',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error'
};

/**
 * User-friendly error messages
 */
export const ErrorMessages = {
  // Connection errors
  CONNECTION_LOST: {
    title: 'Connection Lost',
    message: 'We lost connection to the mining pool. Trying to reconnect...',
    suggestion: 'Please check your internet connection.',
    code: 'CONN_001'
  },
  
  CONNECTION_TIMEOUT: {
    title: 'Connection Timeout',
    message: 'The server is taking too long to respond.',
    suggestion: 'This might be due to high traffic. Please try again in a moment.',
    code: 'CONN_002'
  },
  
  NETWORK_ERROR: {
    title: 'Network Error',
    message: 'Unable to reach the server.',
    suggestion: 'Check your firewall settings and internet connection.',
    code: 'CONN_003'
  },
  
  // Authentication errors
  INVALID_CREDENTIALS: {
    title: 'Invalid Credentials',
    message: 'The wallet address or password is incorrect.',
    suggestion: 'Please double-check your wallet address and try again.',
    code: 'AUTH_001'
  },
  
  SESSION_EXPIRED: {
    title: 'Session Expired',
    message: 'Your session has expired for security reasons.',
    suggestion: 'Please log in again to continue.',
    code: 'AUTH_002'
  },
  
  UNAUTHORIZED_ACCESS: {
    title: 'Access Denied',
    message: 'You don\'t have permission to access this resource.',
    suggestion: 'Contact support if you believe this is an error.',
    code: 'AUTH_003'
  },
  
  // Mining errors
  INVALID_SHARE: {
    title: 'Share Rejected',
    message: 'Your submitted share was invalid.',
    suggestion: 'This is normal occasionally. If it happens frequently, check your mining software.',
    code: 'MINE_001'
  },
  
  STALE_SHARE: {
    title: 'Stale Share',
    message: 'Your share was submitted too late.',
    suggestion: 'Consider reducing your mining software\'s queue size or improving your connection.',
    code: 'MINE_002'
  },
  
  DIFFICULTY_TOO_LOW: {
    title: 'Difficulty Too Low',
    message: 'Your share difficulty is below the minimum required.',
    suggestion: 'The pool will automatically adjust your difficulty. Please wait a moment.',
    code: 'MINE_003'
  },
  
  // Payment errors
  INVALID_ADDRESS: {
    title: 'Invalid Wallet Address',
    message: 'The provided wallet address is not valid.',
    suggestion: 'Please check your wallet address format and try again.',
    code: 'PAY_001'
  },
  
  BALANCE_TOO_LOW: {
    title: 'Balance Too Low',
    message: 'Your balance is below the minimum payout threshold.',
    suggestion: 'Continue mining to reach the minimum payout amount.',
    code: 'PAY_002'
  },
  
  PAYMENT_FAILED: {
    title: 'Payment Failed',
    message: 'We couldn\'t process your payment at this time.',
    suggestion: 'Don\'t worry, your balance is safe. We\'ll retry automatically.',
    code: 'PAY_003'
  },
  
  // System errors
  MAINTENANCE_MODE: {
    title: 'Maintenance Mode',
    message: 'The pool is currently undergoing maintenance.',
    suggestion: 'Please check back in a few minutes. Your shares and balance are safe.',
    code: 'SYS_001'
  },
  
  RATE_LIMITED: {
    title: 'Too Many Requests',
    message: 'You\'ve made too many requests in a short time.',
    suggestion: 'Please wait a moment before trying again.',
    code: 'SYS_002'
  },
  
  SERVER_ERROR: {
    title: 'Server Error',
    message: 'Something went wrong on our end.',
    suggestion: 'We\'re working to fix it. Please try again later.',
    code: 'SYS_003'
  }
};

/**
 * Success messages
 */
export const SuccessMessages = {
  SHARE_ACCEPTED: {
    title: 'Share Accepted',
    message: 'Your share has been accepted by the pool.',
    icon: '✓'
  },
  
  BLOCK_FOUND: {
    title: 'Block Found!',
    message: 'Congratulations! The pool found a new block.',
    icon: '🎉'
  },
  
  PAYMENT_SENT: {
    title: 'Payment Sent',
    message: 'Your payment has been sent successfully.',
    icon: '💰'
  },
  
  SETTINGS_SAVED: {
    title: 'Settings Saved',
    message: 'Your settings have been updated.',
    icon: '✓'
  },
  
  WORKER_ADDED: {
    title: 'Worker Added',
    message: 'Your new worker has been added successfully.',
    icon: '⛏️'
  }
};

/**
 * User feedback formatter
 */
export class UserFeedback {
  /**
   * Format error for user display
   */
  static formatError(error, context = {}) {
    // Map technical errors to user-friendly messages
    const errorKey = this.getErrorKey(error);
    const errorTemplate = ErrorMessages[errorKey] || ErrorMessages.SERVER_ERROR;
    
    // Add context-specific information
    let message = errorTemplate.message;
    let suggestion = errorTemplate.suggestion;
    
    // Add specific details based on context
    if (context.retryAfter) {
      suggestion += ` Try again in ${this.formatDuration(context.retryAfter)}.`;
    }
    
    if (context.minAmount) {
      message += ` Minimum amount: ${context.minAmount} BTC.`;
    }
    
    if (context.currentDifficulty) {
      message += ` Current difficulty: ${context.currentDifficulty}.`;
    }
    
    return {
      type: MessageType.ERROR,
      title: errorTemplate.title,
      message,
      suggestion,
      code: errorTemplate.code,
      timestamp: new Date().toISOString(),
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };
  }
  
  /**
   * Format success message
   */
  static formatSuccess(action, data = {}) {
    const template = SuccessMessages[action] || {
      title: 'Success',
      message: 'Operation completed successfully.',
      icon: '✓'
    };
    
    let message = template.message;
    
    // Add specific data
    if (data.amount) {
      message += ` Amount: ${data.amount} BTC.`;
    }
    
    if (data.blockHeight) {
      message += ` Block height: ${data.blockHeight}.`;
    }
    
    if (data.txHash) {
      message += ` Transaction: ${data.txHash.substring(0, 10)}...`;
    }
    
    return {
      type: MessageType.SUCCESS,
      title: template.title,
      message,
      icon: template.icon,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Create info message
   */
  static info(title, message) {
    return {
      type: MessageType.INFO,
      title,
      message,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Create warning message
   */
  static warning(title, message, suggestion = null) {
    return {
      type: MessageType.WARNING,
      title,
      message,
      suggestion,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Get error key from error object
   */
  static getErrorKey(error) {
    // Map error codes to message keys
    const errorMap = {
      'ECONNREFUSED': 'CONNECTION_LOST',
      'ETIMEDOUT': 'CONNECTION_TIMEOUT',
      'ENETUNREACH': 'NETWORK_ERROR',
      'INVALID_AUTH': 'INVALID_CREDENTIALS',
      'TOKEN_EXPIRED': 'SESSION_EXPIRED',
      'FORBIDDEN': 'UNAUTHORIZED_ACCESS',
      'INVALID_SHARE': 'INVALID_SHARE',
      'STALE_SHARE': 'STALE_SHARE',
      'LOW_DIFFICULTY': 'DIFFICULTY_TOO_LOW',
      'INVALID_ADDRESS': 'INVALID_ADDRESS',
      'INSUFFICIENT_BALANCE': 'BALANCE_TOO_LOW',
      'PAYMENT_ERROR': 'PAYMENT_FAILED',
      'MAINTENANCE': 'MAINTENANCE_MODE',
      'RATE_LIMIT': 'RATE_LIMITED'
    };
    
    return errorMap[error.code] || 'SERVER_ERROR';
  }
  
  /**
   * Format duration for display
   */
  static formatDuration(seconds) {
    if (seconds < 60) {
      return `${seconds} seconds`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      const hours = Math.floor(seconds / 3600);
      return `${hours} hour${hours > 1 ? 's' : ''}`;
    }
  }
  
  /**
   * Create progress message
   */
  static progress(title, current, total) {
    const percentage = Math.round((current / total) * 100);
    
    return {
      type: MessageType.INFO,
      title,
      message: `${percentage}% complete (${current}/${total})`,
      progress: {
        current,
        total,
        percentage
      },
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Create notification for important events
   */
  static notification(event, data = {}) {
    const notifications = {
      NEW_BLOCK: {
        title: 'New Block Available',
        message: `New work available at height ${data.height}`,
        priority: 'high'
      },
      
      DIFFICULTY_CHANGE: {
        title: 'Difficulty Adjusted',
        message: `Your difficulty has been adjusted to ${data.difficulty}`,
        priority: 'medium'
      },
      
      PAYMENT_PENDING: {
        title: 'Payment Pending',
        message: `Payment of ${data.amount} BTC is being processed`,
        priority: 'high'
      },
      
      WORKER_OFFLINE: {
        title: 'Worker Offline',
        message: `Worker "${data.workerName}" hasn\'t submitted shares recently`,
        priority: 'medium'
      },
      
      HASHRATE_DROP: {
        title: 'Hashrate Drop Detected',
        message: 'Your hashrate has dropped significantly',
        priority: 'high'
      }
    };
    
    const template = notifications[event];
    if (!template) {
      return null;
    }
    
    return {
      type: MessageType.INFO,
      ...template,
      timestamp: new Date().toISOString(),
      data
    };
  }
}

/**
 * Toast notification system
 */
export class ToastManager {
  constructor() {
    this.toasts = new Map();
    this.nextId = 1;
  }
  
  /**
   * Show toast notification
   */
  show(message, options = {}) {
    const id = this.nextId++;
    
    const toast = {
      id,
      ...message,
      duration: options.duration || 5000,
      position: options.position || 'top-right',
      closable: options.closable !== false,
      action: options.action || null
    };
    
    this.toasts.set(id, toast);
    
    // Auto-remove after duration
    if (toast.duration > 0) {
      setTimeout(() => this.remove(id), toast.duration);
    }
    
    return id;
  }
  
  /**
   * Remove toast
   */
  remove(id) {
    this.toasts.delete(id);
  }
  
  /**
   * Get all active toasts
   */
  getAll() {
    return Array.from(this.toasts.values());
  }
  
  /**
   * Clear all toasts
   */
  clear() {
    this.toasts.clear();
  }
}

/**
 * Form validation messages
 */
export const ValidationMessages = {
  required: (field) => `${field} is required`,
  email: 'Please enter a valid email address',
  wallet: 'Please enter a valid wallet address',
  number: 'Please enter a valid number',
  min: (field, min) => `${field} must be at least ${min}`,
  max: (field, max) => `${field} must be at most ${max}`,
  minLength: (field, length) => `${field} must be at least ${length} characters`,
  maxLength: (field, length) => `${field} must be at most ${length} characters`,
  pattern: (field) => `${field} format is invalid`,
  match: (field1, field2) => `${field1} and ${field2} must match`,
  unique: (field) => `This ${field} is already taken`,
  alphanumeric: 'Only letters and numbers are allowed',
  strongPassword: 'Password must contain uppercase, lowercase, number and special character'
};

/**
 * Help text for common actions
 */
export const HelpText = {
  WALLET_ADDRESS: 'Enter your BTC wallet address where you want to receive payments',
  WORKER_NAME: 'A unique name for your mining device (e.g., "RIG-01" or "GPU-Miner")',
  DIFFICULTY: 'The pool will automatically adjust this based on your hashrate',
  MINIMUM_PAYOUT: 'You\'ll receive payment when your balance reaches this amount',
  EMAIL_NOTIFICATIONS: 'Get notified about important events like payments and worker issues',
  TWO_FACTOR: 'Add an extra layer of security to your account',
  API_KEY: 'Use this to connect mining software or access the API programmatically'
};

export default UserFeedback;