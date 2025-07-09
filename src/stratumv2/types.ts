/**
 * @file src/stratumv2/types.ts
 * @description Defines the core data types and binary message framing for the Stratum V2 protocol.
 * @note All multi-byte integers are handled in little-endian format as per the specification.
 */

/**
 * Represents the header of every Stratum V2 message.
 */
export interface MessageHeader {
  extensionType: number; // U16
  messageType: number;   // U8
  messageLength: number; // U24
}

export const HEADER_LENGTH = 6; // U16 + U8 + U24 = 2 + 1 + 3 = 6 bytes

/**
 * A collection of utility functions for reading and writing Stratum V2 data types from/to Buffers.
 */
export class Sv2Buffer {

  /**
   * Parses a 6-byte message header from a buffer.
   * @param buffer The buffer to read from, must be at least 6 bytes long.
   * @returns A MessageHeader object.
   */
  static readHeader(buffer: Buffer): MessageHeader {
    if (buffer.length < HEADER_LENGTH) {
      throw new Error('Buffer too small to contain a message header.');
    }

    return {
      extensionType: buffer.readUInt16LE(0),
      messageType: buffer.readUInt8(2),
      messageLength: buffer.readUIntLE(3, 3), // U24
    };
  }

  /**
   * Writes a MessageHeader object to a new 6-byte buffer.
   * @param header The MessageHeader object to serialize.
   * @returns A 6-byte buffer containing the header data.
   */
  static writeHeader(header: MessageHeader): Buffer {
    const buffer = Buffer.alloc(HEADER_LENGTH);
    buffer.writeUInt16LE(header.extensionType, 0);
    buffer.writeUInt8(header.messageType, 2);
    buffer.writeUIntLE(header.messageLength, 3, 3); // U24
    return buffer;
  }

  /**
   * Reads a fixed-length string (STR0_255) from a buffer.
   * The string is prefixed with a U8 length.
   * @param buffer The buffer to read from.
   * @param offset The offset to start reading from.
   * @returns An object containing the read string and the number of bytes read.
   */
  static readString(buffer: Buffer, offset: number): { value: string; bytesRead: number } {
    const length = buffer.readUInt8(offset);
    const value = buffer.toString('ascii', offset + 1, offset + 1 + length);
    return { value, bytesRead: 1 + length };
  }

  /**
   * Writes a string to a buffer, prefixed with its U8 length.
   * @param value The string to write (max 255 chars).
   * @returns A new buffer containing the length-prefixed string.
   */
  static writeString(value: string): Buffer {
    const strBuffer = Buffer.from(value, 'ascii');
    if (strBuffer.length > 255) {
      throw new Error('String exceeds maximum length of 255 bytes.');
    }
    const lenBuffer = Buffer.alloc(1);
    lenBuffer.writeUInt8(strBuffer.length, 0);
    return Buffer.concat([lenBuffer, strBuffer]);
  }
}
