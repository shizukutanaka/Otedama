/**
 * NonceAllocator
 * Splits the 32-bit nonce space into equal, non-overlapping ranges for GPU workers.
 *
 * This simple allocator assumes the classic 0x00000000-0xFFFFFFFF nonce range and cuts it
 * into `totalWorkers` contiguous segments. Each worker is assigned the segment with the
 * same index it holds in the worker pool (0-based).
 *
 * Example:
 *   const { allocateRange } = require('./nonce-allocator');
 *   const { start, end } = allocateRange(workerIndex, totalWorkers);
 *
 * Note: We intentionally keep this utility free of any other project dependencies so it
 * can be reused in the browser or worker threads if needed.
 */

const MAX_NONCE = 0xFFFFFFFF >>> 0; // 4,294,967,295 (uint32 max)

/**
 * Allocates a deterministic nonce range for a worker.
 *
 * @param {number} workerIndex ‑ Zero-based index of the worker requesting the range.
 * @param {number} totalWorkers ‑ Total number of workers in the pool.
 * @returns {{ start: number, end: number }} The inclusive start and end of the nonce range.
 */
function allocateRange(workerIndex, totalWorkers) {
  if (!Number.isInteger(workerIndex) || !Number.isInteger(totalWorkers)) {
    throw new TypeError('workerIndex and totalWorkers must be integers');
  }
  if (workerIndex < 0 || workerIndex >= totalWorkers) {
    throw new RangeError('workerIndex out of bounds');
  }
  if (totalWorkers <= 0) {
    throw new RangeError('totalWorkers must be > 0');
  }

  const segmentSize = Math.floor((MAX_NONCE + 1) / totalWorkers);
  const start = segmentSize * workerIndex;
  // Last worker takes any remainder to avoid gaps due to integer division.
  const end = workerIndex === totalWorkers - 1 ? MAX_NONCE : start + segmentSize - 1;

  return { start, end };
}

export {
  MAX_NONCE,
  allocateRange
};
