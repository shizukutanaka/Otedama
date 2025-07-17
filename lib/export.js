/**
 * Data Export System for Otedama
 * Provides comprehensive data export functionality in various formats
 */

import { EventEmitter } from 'events';
import { createWriteStream, createReadStream } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createGzip } from 'zlib';
import { Logger } from './logger.js';
import archiver from 'archiver';

/**
 * Export formats
 */
export const ExportFormat = {
  JSON: 'json',
  CSV: 'csv',
  EXCEL: 'excel',
  PDF: 'pdf',
  XML: 'xml',
  SQL: 'sql',
  ARCHIVE: 'archive'
};

/**
 * Export options
 */
export const ExportOptions = {
  COMPRESS: 'compress',
  ENCRYPT: 'encrypt',
  INCLUDE_METADATA: 'includeMetadata',
  SPLIT_FILES: 'splitFiles',
  STREAMING: 'streaming'
};

/**
 * CSV Exporter
 */
class CSVExporter {
  constructor(options = {}) {
    this.delimiter = options.delimiter || ',';
    this.quote = options.quote || '"';
    this.escape = options.escape || '"';
    this.newline = options.newline || '\n';
    this.header = options.header !== false;
  }
  
  export(data, columns = null) {
    if (!Array.isArray(data) || data.length === 0) {
      return '';
    }
    
    // Auto-detect columns if not provided
    if (!columns) {
      columns = Object.keys(data[0]);
    }
    
    const rows = [];
    
    // Add header
    if (this.header) {
      rows.push(this.formatRow(columns));
    }
    
    // Add data rows
    for (const item of data) {
      const values = columns.map(col => this.getNestedValue(item, col));
      rows.push(this.formatRow(values));
    }
    
    return rows.join(this.newline);
  }
  
  formatRow(values) {
    return values.map(value => this.formatValue(value)).join(this.delimiter);
  }
  
  formatValue(value) {
    if (value === null || value === undefined) {
      return '';
    }
    
    const stringValue = String(value);
    
    // Check if value needs quoting
    if (
      stringValue.includes(this.delimiter) ||
      stringValue.includes(this.quote) ||
      stringValue.includes(this.newline) ||
      stringValue.includes('\r')
    ) {
      // Escape quotes
      const escaped = stringValue.replace(
        new RegExp(this.quote, 'g'),
        this.escape + this.quote
      );
      
      return this.quote + escaped + this.quote;
    }
    
    return stringValue;
  }
  
  getNestedValue(obj, path) {
    const keys = path.split('.');
    let value = obj;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return null;
      }
    }
    
    return value;
  }
}

/**
 * JSON Exporter
 */
class JSONExporter {
  constructor(options = {}) {
    this.pretty = options.pretty !== false;
    this.replacer = options.replacer;
    this.space = options.space || 2;
  }
  
  export(data) {
    if (this.pretty) {
      return JSON.stringify(data, this.replacer, this.space);
    }
    
    return JSON.stringify(data, this.replacer);
  }
}

/**
 * XML Exporter
 */
class XMLExporter {
  constructor(options = {}) {
    this.rootElement = options.rootElement || 'data';
    this.itemElement = options.itemElement || 'item';
    this.pretty = options.pretty !== false;
    this.declaration = options.declaration !== false;
  }
  
  export(data) {
    const lines = [];
    
    if (this.declaration) {
      lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    }
    
    lines.push(`<${this.rootElement}>`);
    
    if (Array.isArray(data)) {
      for (const item of data) {
        lines.push(this.exportItem(item, 1));
      }
    } else {
      lines.push(this.exportObject(data, 1));
    }
    
    lines.push(`</${this.rootElement}>`);
    
    return lines.join(this.pretty ? '\n' : '');
  }
  
  exportItem(item, level) {
    const indent = this.pretty ? '  '.repeat(level) : '';
    const lines = [];
    
    lines.push(`${indent}<${this.itemElement}>`);
    lines.push(this.exportObject(item, level + 1));
    lines.push(`${indent}</${this.itemElement}>`);
    
    return lines.join(this.pretty ? '\n' : '');
  }
  
  exportObject(obj, level) {
    const indent = this.pretty ? '  '.repeat(level) : '';
    const lines = [];
    
    for (const [key, value] of Object.entries(obj)) {
      const safeKey = this.sanitizeKey(key);
      
      if (value === null || value === undefined) {
        lines.push(`${indent}<${safeKey}/>`);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        lines.push(`${indent}<${safeKey}>`);
        lines.push(this.exportObject(value, level + 1));
        lines.push(`${indent}</${safeKey}>`);
      } else if (Array.isArray(value)) {
        lines.push(`${indent}<${safeKey}>`);
        for (const item of value) {
          if (typeof item === 'object') {
            lines.push(this.exportItem(item, level + 1));
          } else {
            lines.push(`${indent}  <value>${this.escapeValue(item)}</value>`);
          }
        }
        lines.push(`${indent}</${safeKey}>`);
      } else {
        lines.push(`${indent}<${safeKey}>${this.escapeValue(value)}</${safeKey}>`);
      }
    }
    
    return lines.join(this.pretty ? '\n' : '');
  }
  
  sanitizeKey(key) {
    // XML element names must start with letter or underscore
    return key.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[0-9-]/, '_$&');
  }
  
  escapeValue(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

/**
 * SQL Exporter
 */
class SQLExporter {
  constructor(options = {}) {
    this.tableName = options.tableName || 'exported_data';
    this.dialect = options.dialect || 'mysql';
    this.createTable = options.createTable !== false;
    this.dropTable = options.dropTable || false;
  }
  
  export(data, columns = null) {
    if (!Array.isArray(data) || data.length === 0) {
      return '';
    }
    
    const statements = [];
    
    // Auto-detect columns
    if (!columns) {
      columns = this.detectColumns(data);
    }
    
    // Drop table
    if (this.dropTable) {
      statements.push(this.generateDropTable());
    }
    
    // Create table
    if (this.createTable) {
      statements.push(this.generateCreateTable(columns));
    }
    
    // Insert data
    statements.push(...this.generateInserts(data, columns));
    
    return statements.join('\n\n');
  }
  
  detectColumns(data) {
    const columns = {};
    
    // Sample first 100 rows to detect types
    const sample = data.slice(0, 100);
    
    for (const row of sample) {
      for (const [key, value] of Object.entries(row)) {
        if (!columns[key]) {
          columns[key] = this.detectType(value);
        }
      }
    }
    
    return columns;
  }
  
  detectType(value) {
    if (value === null || value === undefined) {
      return 'VARCHAR(255)';
    }
    
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'INTEGER' : 'DECIMAL(10,2)';
    }
    
    if (typeof value === 'boolean') {
      return 'BOOLEAN';
    }
    
    if (value instanceof Date) {
      return 'TIMESTAMP';
    }
    
    const stringValue = String(value);
    
    if (stringValue.length > 255) {
      return 'TEXT';
    }
    
    return 'VARCHAR(255)';
  }
  
  generateDropTable() {
    return `DROP TABLE IF EXISTS ${this.escapeIdentifier(this.tableName)};`;
  }
  
  generateCreateTable(columns) {
    const columnDefs = Object.entries(columns)
      .map(([name, type]) => `  ${this.escapeIdentifier(name)} ${type}`)
      .join(',\n');
    
    return `CREATE TABLE ${this.escapeIdentifier(this.tableName)} (\n${columnDefs}\n);`;
  }
  
  generateInserts(data, columns) {
    const columnNames = Object.keys(columns);
    const escapedColumns = columnNames.map(col => this.escapeIdentifier(col));
    
    const statements = [];
    const batchSize = 100;
    
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const values = batch.map(row => {
        const rowValues = columnNames.map(col => this.escapeValue(row[col]));
        return `(${rowValues.join(', ')})`;
      });
      
      statements.push(
        `INSERT INTO ${this.escapeIdentifier(this.tableName)} (${escapedColumns.join(', ')}) VALUES\n` +
        values.join(',\n') + ';'
      );
    }
    
    return statements;
  }
  
  escapeIdentifier(identifier) {
    switch (this.dialect) {
      case 'mysql':
        return '`' + identifier.replace(/`/g, '``') + '`';
      case 'postgres':
        return '"' + identifier.replace(/"/g, '""') + '"';
      default:
        return identifier;
    }
  }
  
  escapeValue(value) {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    
    if (typeof value === 'number') {
      return String(value);
    }
    
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }
    
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    
    // Escape string
    return "'" + String(value).replace(/'/g, "''") + "'";
  }
}

/**
 * Export Manager
 */
export class ExportManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      outputPath: options.outputPath || './exports',
      maxFileSize: options.maxFileSize || 100 * 1024 * 1024, // 100MB
      compression: options.compression !== false,
      ...options
    };
    
    this.logger = options.logger || new Logger();
    this.exporters = new Map();
    
    // Register default exporters
    this.registerExporter(ExportFormat.JSON, new JSONExporter());
    this.registerExporter(ExportFormat.CSV, new CSVExporter());
    this.registerExporter(ExportFormat.XML, new XMLExporter());
    this.registerExporter(ExportFormat.SQL, new SQLExporter());
  }
  
  /**
   * Register custom exporter
   */
  registerExporter(format, exporter) {
    this.exporters.set(format, exporter);
  }
  
  /**
   * Export data
   */
  async export(data, format, options = {}) {
    const exportId = this.generateExportId();
    const startTime = Date.now();
    
    this.emit('export:start', { exportId, format, options });
    
    try {
      let result;
      
      switch (format) {
        case ExportFormat.ARCHIVE:
          result = await this.exportArchive(data, options);
          break;
          
        case ExportFormat.PDF:
          result = await this.exportPDF(data, options);
          break;
          
        case ExportFormat.EXCEL:
          result = await this.exportExcel(data, options);
          break;
          
        default:
          result = await this.exportWithFormat(data, format, options);
      }
      
      const duration = Date.now() - startTime;
      
      this.emit('export:complete', {
        exportId,
        format,
        duration,
        size: result.size,
        path: result.path
      });
      
      return result;
    } catch (error) {
      this.emit('export:error', { exportId, format, error });
      throw error;
    }
  }
  
  /**
   * Export with specific format
   */
  async exportWithFormat(data, format, options) {
    const exporter = this.exporters.get(format);
    
    if (!exporter) {
      throw new Error(`Unsupported export format: ${format}`);
    }
    
    // Export data
    const content = exporter.export(data, options.columns);
    
    // Determine filename
    const filename = options.filename || `export_${Date.now()}.${format}`;
    const filepath = join(this.options.outputPath, filename);
    
    // Ensure directory exists
    await this.ensureDirectory(dirname(filepath));
    
    // Handle large data with streaming
    if (options.streaming || content.length > this.options.maxFileSize) {
      return await this.streamExport(content, filepath, options);
    }
    
    // Write file
    await writeFile(filepath, content, 'utf8');
    
    // Compress if needed
    if (this.options.compression && options.compress !== false) {
      const compressedPath = await this.compressFile(filepath);
      return {
        path: compressedPath,
        size: (await this.getFileSize(compressedPath)),
        format,
        compressed: true
      };
    }
    
    return {
      path: filepath,
      size: Buffer.byteLength(content),
      format,
      compressed: false
    };
  }
  
  /**
   * Export as archive
   */
  async exportArchive(data, options) {
    const filename = options.filename || `export_${Date.now()}.zip`;
    const filepath = join(this.options.outputPath, filename);
    
    await this.ensureDirectory(dirname(filepath));
    
    const output = createWriteStream(filepath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });
    
    return new Promise((resolve, reject) => {
      output.on('close', () => {
        resolve({
          path: filepath,
          size: archive.pointer(),
          format: ExportFormat.ARCHIVE,
          compressed: true
        });
      });
      
      archive.on('error', reject);
      
      archive.pipe(output);
      
      // Add metadata
      if (options.includeMetadata) {
        archive.append(JSON.stringify({
          exportDate: new Date().toISOString(),
          recordCount: Array.isArray(data) ? data.length : 1,
          options
        }, null, 2), { name: 'metadata.json' });
      }
      
      // Export in multiple formats
      const formats = options.formats || [ExportFormat.JSON, ExportFormat.CSV];
      
      for (const format of formats) {
        const exporter = this.exporters.get(format);
        if (exporter) {
          const content = exporter.export(data, options.columns);
          archive.append(content, { name: `data.${format}` });
        }
      }
      
      archive.finalize();
    });
  }
  
  /**
   * Export as PDF
   */
  async exportPDF(data, options) {
    // TODO: Implement PDF export using a library like pdfkit
    throw new Error('PDF export not implemented');
  }
  
  /**
   * Export as Excel
   */
  async exportExcel(data, options) {
    // TODO: Implement Excel export using a library like exceljs
    throw new Error('Excel export not implemented');
  }
  
  /**
   * Stream export for large files
   */
  async streamExport(content, filepath, options) {
    const writeStream = createWriteStream(filepath);
    
    return new Promise((resolve, reject) => {
      writeStream.on('finish', () => {
        resolve({
          path: filepath,
          size: writeStream.bytesWritten,
          format: options.format,
          compressed: false
        });
      });
      
      writeStream.on('error', reject);
      
      // Write in chunks
      const chunkSize = 64 * 1024; // 64KB chunks
      let offset = 0;
      
      while (offset < content.length) {
        const chunk = content.slice(offset, offset + chunkSize);
        writeStream.write(chunk);
        offset += chunkSize;
      }
      
      writeStream.end();
    });
  }
  
  /**
   * Compress file
   */
  async compressFile(filepath) {
    const compressedPath = filepath + '.gz';
    
    return new Promise((resolve, reject) => {
      const readStream = createReadStream(filepath);
      const writeStream = createWriteStream(compressedPath);
      const gzip = createGzip();
      
      writeStream.on('finish', () => resolve(compressedPath));
      writeStream.on('error', reject);
      
      readStream.pipe(gzip).pipe(writeStream);
    });
  }
  
  /**
   * Get file size
   */
  async getFileSize(filepath) {
    const { size } = await stat(filepath);
    return size;
  }
  
  /**
   * Ensure directory exists
   */
  async ensureDirectory(dir) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
  
  /**
   * Generate export ID
   */
  generateExportId() {
    return `export_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
  
  /**
   * Batch export
   */
  async batchExport(datasets, format, options = {}) {
    const results = [];
    
    for (const [name, data] of Object.entries(datasets)) {
      try {
        const result = await this.export(data, format, {
          ...options,
          filename: `${name}_${Date.now()}.${format}`
        });
        
        results.push({
          name,
          success: true,
          result
        });
      } catch (error) {
        results.push({
          name,
          success: false,
          error
        });
      }
    }
    
    return results;
  }
  
  /**
   * Schedule export
   */
  scheduleExport(data, format, schedule, options = {}) {
    // TODO: Implement scheduled exports
    throw new Error('Scheduled exports not implemented');
  }
}

// Create singleton instance
let exportInstance;

export function createExportManager(options) {
  if (!exportInstance) {
    exportInstance = new ExportManager(options);
  }
  return exportInstance;
}

export function getExportManager() {
  if (!exportInstance) {
    throw new Error('Export manager not initialized');
  }
  return exportInstance;
}