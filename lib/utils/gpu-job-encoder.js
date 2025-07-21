/**
 * GPU Job Encoder / Decoder
 *
 * For the first implementation we simply JSON.stringify the job object and
 * convert it to a UTF-8 Buffer. This keeps implementation simple while still
 * benefiting from WebSocket binary frames and permessage-deflate compression.
 *
 * Later we can swap the serializer for CBOR, MessagePack, or custom binary
 * layout without changing call-sites.
 */

export function encodeGpuJob(job) {
  if (Buffer.isBuffer(job)) {
    // Pass-through if already encoded
    return job;
  }
  const json = JSON.stringify(job);
  return Buffer.from(json, 'utf8');
}

export function decodeGpuJob(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('decodeGpuJob expects Buffer');
  }
  const json = buffer.toString('utf8');
  return JSON.parse(json);
}
