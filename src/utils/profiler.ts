import * as pprof from 'pprof-it';
import * as fs from 'fs';
import * as path from 'path';
import { ComponentLogger } from '../logger'; // Assuming logger is in the root

let profiling = false;
let profileStop: (() => Promise<Buffer>) | null = null;

/**
 * Starts CPU profiling for a specified duration.
 * @param durationSeconds The duration to profile for, in seconds.
 * @param logger A logger instance to log messages.
 * @returns A promise that resolves when profiling has started.
 */
export async function startProfiling(durationSeconds: number, logger: ComponentLogger): Promise<void> {
  if (profiling) {
    logger.warn('Profiling is already in progress.');
    return;
  }

  logger.info(`Starting CPU profiling for ${durationSeconds} seconds.`);
  profiling = true;

  try {
    profileStop = await pprof.time.start(durationSeconds * 1000, 500);
    logger.info('Profiling started successfully.');
  } catch (err) {
    profiling = false;
    logger.error('Failed to start profiling:', err);
    throw err;
  }
}

/**
 * Stops the current profiling session and saves the result to a file.
 * @param logger A logger instance to log messages.
 * @returns A promise that resolves with the path to the saved profile file, or null if not profiling.
 */
export async function stopProfiling(logger: ComponentLogger): Promise<string | null> {
  if (!profiling || !profileStop) {
    logger.warn('Profiling is not currently running.');
    return null;
  }

  logger.info('Stopping CPU profiling...');

  try {
    const profile = await profileStop();
    profiling = false;
    profileStop = null;

    const profileDir = path.join(__dirname, '..', '..', 'profiles');
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const fileName = `profile-${new Date().toISOString().replace(/[:.]/g, '-')}.pb.gz`;
    const filePath = path.join(profileDir, fileName);

    fs.writeFileSync(filePath, profile);
    logger.info(`Profiling data saved to: ${filePath}`);
    return filePath;
  } catch (err) {
    profiling = false;
    profileStop = null;
    logger.error('Failed to stop profiling or save data:', err);
    throw err;
  }
}

/**
 * Checks if profiling is currently active.
 * @returns True if profiling is active, false otherwise.
 */
export function isProfiling(): boolean {
  return profiling;
}
