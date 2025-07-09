/**
 * @file test/stratumv2/messages.test.ts
 * @description Unit tests for the Stratum V2 message serialization and deserialization.
 */

import {
  serializeSetupConnection,
  deserializeSetupConnection,
  serializeSetupConnectionSuccess,
  deserializeSetupConnectionSuccess,
  serializeSetupConnectionError,
  deserializeSetupConnectionError,
  SetupConnection,
  SetupConnectionSuccess,
  SetupConnectionError
} from '../../src/stratumv2/messages';

describe('Stratum V2 Message Serialization/Deserialization', () => {

  describe('SetupConnection', () => {
    it('should correctly serialize and deserialize a SetupConnection message', () => {
      const originalMessage: SetupConnection = {
        protocol: 0, // Mining Protocol
        minVersion: 2,
        maxVersion: 2,
        flags: 0b1, // Supports some feature
        endpointHost: 'pool.example.com',
        endpointPort: 3333,
        vendor: 'OtedamaMiner',
        hardwareVersion: 'v1.0',
        firmware: 'otd-fw-2025.7',
        deviceId: 'device-001'
      };

      const serialized = serializeSetupConnection(originalMessage);
      const deserialized = deserializeSetupConnection(serialized);

      expect(deserialized).toEqual(originalMessage);
    });
  });

  describe('SetupConnection.Success', () => {
    it('should correctly serialize and deserialize a SetupConnection.Success message', () => {
      const originalMessage: SetupConnectionSuccess = {
        usedVersion: 2,
        flags: 0b1, // Server supports the feature
      };

      const serialized = serializeSetupConnectionSuccess(originalMessage);
      const deserialized = deserializeSetupConnectionSuccess(serialized);

      expect(deserialized).toEqual(originalMessage);
    });
  });

  describe('SetupConnection.Error', () => {
    it('should correctly serialize and deserialize a SetupConnection.Error message', () => {
      const originalMessage: SetupConnectionError = {
        flags: 0,
        errorCode: 'unsupported-protocol',
      };

      const serialized = serializeSetupConnectionError(originalMessage);
      const deserialized = deserializeSetupConnectionError(serialized);

      expect(deserialized).toEqual(originalMessage);
    });
  });

});
