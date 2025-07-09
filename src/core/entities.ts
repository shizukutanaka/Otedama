/**
 * Core Mining Pool Entities
 * 
 * Pike's Simplicity: Simple data structures without unnecessary abstraction
 * Uncle Bob's Clean Architecture: Clear domain entities
 * Carmack's Performance: Direct, minimal objects
 */

export interface Share {
  readonly minerId: string;
  readonly jobId: string;
  readonly nonce: number;
  readonly timestamp: number;
  readonly difficulty: number;
  readonly hash: string;
  readonly isValid: boolean;
}

export interface Miner {
  readonly id: string;
  readonly address: string;
  readonly worker: string;
  readonly connectedAt: number;
  hashrate: number;
  sharesSubmitted: number;
  sharesAccepted: number;
  lastActivity: number;
}

export interface Job {
  readonly id: string;
  readonly previousBlockHash: string;
  readonly coinbaseHash: string;
  readonly merkleRoot: string;
  readonly timestamp: number;
  readonly difficulty: number;
  readonly height: number;
}

export interface Block {
  readonly hash: string;
  readonly height: number;
  readonly timestamp: number;
  readonly difficulty: number;
  readonly reward: number;
  readonly foundBy: string;
  readonly shares: Share[];
}

export interface Payout {
  readonly minerId: string;
  readonly amount: number;
  readonly blockHeight: number;
  readonly timestamp: number;
}

// Pike's approach: Simple enums instead of complex types
export enum ShareStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected'
}

export enum ConnectionStatus {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  BANNED = 'banned'
}

// Carmack's approach: Direct factory functions instead of classes
export function createShare(
  minerId: string,
  jobId: string,
  nonce: number,
  difficulty: number,
  hash: string
): Share {
  return {
    minerId,
    jobId,
    nonce,
    timestamp: Date.now(),
    difficulty,
    hash,
    isValid: false // Will be set by validator
  };
}

export function createMiner(
  id: string,
  address: string,
  worker: string = 'default'
): Miner {
  return {
    id,
    address,
    worker,
    connectedAt: Date.now(),
    hashrate: 0,
    sharesSubmitted: 0,
    sharesAccepted: 0,
    lastActivity: Date.now()
  };
}

export function createJob(
  previousBlockHash: string,
  coinbaseHash: string,
  merkleRoot: string,
  difficulty: number,
  height: number
): Job {
  return {
    id: generateJobId(),
    previousBlockHash,
    coinbaseHash,
    merkleRoot,
    timestamp: Date.now(),
    difficulty,
    height
  };
}

// Simple ID generation - Carmack style: direct and fast
function generateJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}