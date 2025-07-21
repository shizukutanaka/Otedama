/**
 * ShareEncoder - simple utilities to encode / decode share objects into Buffer
 * for zero-copy transmission over WebSocket.
 *
 * NOTE: Current implementation uses JSON serialization and Buffer.from().
 * This avoids double-stringify on the WebSocket layer and allows us to move
 * message framing logic into lower layers. A more efficient binary layout
 * (e.g. MessagePack / FlatBuffers) can replace this drop-in later.
 */

export function encodeShare(share) {
  // Return a Buffer directly if caller already supplied one
  if (Buffer.isBuffer(share)) return share;
  return Buffer.from(JSON.stringify(share));
}

export function decodeShare(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeShare expects Buffer');
  }
  try {
    return JSON.parse(buffer.toString());
  } catch (err) {
    // If parsing fails, propagate error to caller
    throw new Error('Failed to decode share buffer: ' + err.message);
  }
}
