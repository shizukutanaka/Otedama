// Logging Configuration
export interface LoggerConfig {
  // Log levels
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  
  // Log format
  format: 'json' | 'text';
  
  // Log rotation settings
  maxFiles: number;           // Maximum number of rotated files
  maxSize: number;           // Maximum size per file in bytes
  compress: boolean;         // Compress rotated files
  
  // File settings
  logDirectory: string;      // Directory for log files
  fileName: string;          // Base filename for logs
  
  // Console output settings
  consoleEnabled: boolean;   // Enable console output
  consoleLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  
  // Error handling
  onError?: (error: Error) => void;
}

// Default configuration
export const defaultLoggerConfig: LoggerConfig = {
  level: 'info',
  format: 'json',
  maxFiles: 10,
  maxSize: 10485760, // 10MB
  compress: true,
  logDirectory: './logs',
  fileName: 'pool.log',
  consoleEnabled: true,
  consoleLevel: 'info',
  onError: (error) => {
    console.error('Logger error:', error);
  }
};

// Load configuration from environment or config file
export function loadLoggerConfig(): LoggerConfig {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultLoggerConfig;
}
