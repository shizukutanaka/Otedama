/**
 * @file src/stratumv2/messages.ts
 * @description Implements the structure and serialization/deserialization for Stratum V2 messages,
 * starting with the connection handshake.
 */

import { Sv2Buffer } from './types';

// As per the specification, the SetupConnection message type is 0.
export const SETUP_CONNECTION_MSG_TYPE = 0;

/**
 * Interface for the SetupConnection message sent by the client.
 */
export interface SetupConnection {
  protocol: number;       // U8
  minVersion: number;     // U16
  maxVersion: number;     // U16
  flags: number;          // U32
  endpointHost: string;   // STR0_255
  endpointPort: number;   // U16
  vendor: string;         // STR0_255
  hardwareVersion: string;// STR0_255
  firmware: string;       // STR0_255
  deviceId: string;       // STR0_255
}

/**
 * Interface for the SetupConnection.Success response from the server.
 */
export interface SetupConnectionSuccess {
  usedVersion: number;    // U16
  flags: number;          // U32
}

/**
 * Interface for the SetupConnection.Error response from the server.
 */
export interface SetupConnectionError {
  flags: number;          // U32
  errorCode: string;      // STR0_255
}

/**
 * Serializes a SetupConnection message payload into a Buffer.
 * @param msg The SetupConnection message object.
 * @returns A buffer containing the serialized payload.
 */
export function serializeSetupConnection(msg: SetupConnection): Buffer {
  const hostBuffer = Sv2Buffer.writeString(msg.endpointHost);
  const vendorBuffer = Sv2Buffer.writeString(msg.vendor);
  const hwVersionBuffer = Sv2Buffer.writeString(msg.hardwareVersion);
  const firmwareBuffer = Sv2Buffer.writeString(msg.firmware);
  const deviceIdBuffer = Sv2Buffer.writeString(msg.deviceId);

  const totalLength = 1 + 2 + 2 + 4 + hostBuffer.length + 2 + vendorBuffer.length + hwVersionBuffer.length + firmwareBuffer.length + deviceIdBuffer.length;
  const buffer = Buffer.alloc(totalLength);

  let offset = 0;
  offset = buffer.writeUInt8(msg.protocol, offset);
  offset = buffer.writeUInt16LE(msg.minVersion, offset);
  offset = buffer.writeUInt16LE(msg.maxVersion, offset);
  offset = buffer.writeUInt32LE(msg.flags, offset);

  hostBuffer.copy(buffer, offset);
  offset += hostBuffer.length;

  offset = buffer.writeUInt16LE(msg.endpointPort, offset);

  vendorBuffer.copy(buffer, offset);
  offset += vendorBuffer.length;

  hwVersionBuffer.copy(buffer, offset);
  offset += hwVersionBuffer.length;

  firmwareBuffer.copy(buffer, offset);
  offset += firmwareBuffer.length;

  deviceIdBuffer.copy(buffer, offset);

  return buffer;
}

/**
 * Deserializes a SetupConnection message payload from a Buffer.
 * @param buffer The buffer containing the serialized payload.
 * @returns A SetupConnection message object.
 */
export function deserializeSetupConnection(buffer: Buffer): SetupConnection {
  let offset = 0;
  const protocol = buffer.readUInt8(offset);
  offset += 1;

  const minVersion = buffer.readUInt16LE(offset);
  offset += 2;

  const maxVersion = buffer.readUInt16LE(offset);
  offset += 2;

  const flags = buffer.readUInt32LE(offset);
  offset += 4;

  const hostResult = Sv2Buffer.readString(buffer, offset);
  offset += hostResult.bytesRead;

  const endpointPort = buffer.readUInt16LE(offset);
  offset += 2;

  const vendorResult = Sv2Buffer.readString(buffer, offset);
  offset += vendorResult.bytesRead;

  const hwVersionResult = Sv2Buffer.readString(buffer, offset);
  offset += hwVersionResult.bytesRead;

  const firmwareResult = Sv2Buffer.readString(buffer, offset);
  offset += firmwareResult.bytesRead;

  const deviceIdResult = Sv2Buffer.readString(buffer, offset);

  return {
    protocol,
    minVersion,
    maxVersion,
    flags,
    endpointHost: hostResult.value,
    endpointPort,
    vendor: vendorResult.value,
    hardwareVersion: hwVersionResult.value,
    firmware: firmwareResult.value,
    deviceId: deviceIdResult.value,
  };
}

/**
 * Serializes a SetupConnection.Success message payload into a Buffer.
 * @param msg The SetupConnectionSuccess message object.
 * @returns A buffer containing the serialized payload.
 */
export function serializeSetupConnectionSuccess(msg: SetupConnectionSuccess): Buffer {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt16LE(msg.usedVersion, 0);
  buffer.writeUInt32LE(msg.flags, 2);
  return buffer;
}

/**
 * Deserializes a SetupConnection.Success message payload from a Buffer.
 * @param buffer The buffer containing the serialized payload.
 * @returns A SetupConnectionSuccess message object.
 */
export function deserializeSetupConnectionSuccess(buffer: Buffer): SetupConnectionSuccess {
  return {
    usedVersion: buffer.readUInt16LE(0),
    flags: buffer.readUInt32LE(2),
  };
}

/**
 * Serializes a SetupConnection.Error message payload into a Buffer.
 * @param msg The SetupConnectionError message object.
 * @returns A buffer containing the serialized payload.
 */
export function serializeSetupConnectionError(msg: SetupConnectionError): Buffer {
    const errorBuffer = Sv2Buffer.writeString(msg.errorCode);
    const buffer = Buffer.alloc(4 + errorBuffer.length);
    buffer.writeUInt32LE(msg.flags, 0);
    errorBuffer.copy(buffer, 4);
    return buffer;
}

/**
 * Deserializes a SetupConnection.Error message payload from a Buffer.
 * @param buffer The buffer containing the serialized payload.
 * @returns A SetupConnectionError message object.
 */
export function deserializeSetupConnectionError(buffer: Buffer): SetupConnectionError {
    const flags = buffer.readUInt32LE(0);
    const { value } = Sv2Buffer.readString(buffer, 4);
    return { flags, errorCode: value };
}
