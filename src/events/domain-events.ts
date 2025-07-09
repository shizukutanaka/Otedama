/**
 * Domain Events - Core Domain Event Types
 * 
 * 設計原則:
 * - Martin: ドメイン駆動設計のイベント
 * - Pike: 明確で理解しやすいイベント構造
 * - Carmack: 効率的なシリアライゼーション
 */

import { Event, EventMetadata } from './event-bus';

// Base domain event interface
export interface DomainEvent<T = any> extends Event {
    aggregateId: string;
    aggregateType: string;
    aggregateVersion: number;
    payload: T;
}

// Pool Domain Events
export interface PoolStartedEvent extends DomainEvent<{
    poolId: string;
    startTime: Date;
    config: any;
}> {
    type: 'pool.started';
}

export interface PoolStoppedEvent extends DomainEvent<{
    poolId: string;
    stopTime: Date;
    reason: string;
}> {
    type: 'pool.stopped';
}

export interface PoolConfigUpdatedEvent extends DomainEvent<{
    poolId: string;
    oldConfig: any;
    newConfig: any;
    updatedBy: string;
}> {
    type: 'pool.config.updated';
}

// Block Domain Events
export interface BlockFoundEvent extends DomainEvent<{
    height: number;
    hash: string;
    previousHash: string;
    timestamp: Date;
    difficulty: number;
    nonce: number;
    reward: number;
    foundBy: string;
}> {
    type: 'block.found';
}

export interface BlockConfirmedEvent extends DomainEvent<{
    height: number;
    hash: string;
    confirmations: number;
    reward: number;
}> {
    type: 'block.confirmed';
}

export interface BlockOrphanedEvent extends DomainEvent<{
    height: number;
    hash: string;
    reason: string;
}> {
    type: 'block.orphaned';
}

// Share Domain Events
export interface ShareSubmittedEvent extends DomainEvent<{
    shareId: string;
    minerId: string;
    workerId: string;
    jobId: string;
    nonce: string;
    difficulty: number;
    timestamp: Date;
}> {
    type: 'share.submitted';
}

export interface ShareAcceptedEvent extends DomainEvent<{
    shareId: string;
    minerId: string;
    workerId: string;
    difficulty: number;
    reward: number;
}> {
    type: 'share.accepted';
}

export interface ShareRejectedEvent extends DomainEvent<{
    shareId: string;
    minerId: string;
    workerId: string;
    reason: string;
    errorCode: string;
}> {
    type: 'share.rejected';
}

// Miner Domain Events
export interface MinerConnectedEvent extends DomainEvent<{
    minerId: string;
    address: string;
    ipAddress: string;
    userAgent: string;
    version: string;
    timestamp: Date;
}> {
    type: 'miner.connected';
}

export interface MinerAuthenticatedEvent extends DomainEvent<{
    minerId: string;
    address: string;
    workerName?: string;
    permissions: string[];
}> {
    type: 'miner.authenticated';
}

export interface MinerDisconnectedEvent extends DomainEvent<{
    minerId: string;
    address: string;
    reason: string;
    duration: number;
    sharesSubmitted: number;
}> {
    type: 'miner.disconnected';
}

export interface MinerBannedEvent extends DomainEvent<{
    minerId: string;
    address: string;
    reason: string;
    bannedBy: string;
    duration?: number;
    permanent: boolean;
}> {
    type: 'miner.banned';
}

// Payment Domain Events
export interface PaymentCalculatedEvent extends DomainEvent<{
    paymentId: string;
    minerId: string;
    amount: number;
    shares: number;
    blockHeight: number;
    calculatedAt: Date;
}> {
    type: 'payment.calculated';
}

export interface PaymentQueuedEvent extends DomainEvent<{
    paymentId: string;
    minerId: string;
    address: string;
    amount: number;
    queuedAt: Date;
}> {
    type: 'payment.queued';
}

export interface PaymentSentEvent extends DomainEvent<{
    paymentId: string;
    minerId: string;
    address: string;
    amount: number;
    txHash: string;
    fee: number;
    sentAt: Date;
}> {
    type: 'payment.sent';
}

export interface PaymentConfirmedEvent extends DomainEvent<{
    paymentId: string;
    txHash: string;
    confirmations: number;
    confirmedAt: Date;
}> {
    type: 'payment.confirmed';
}

export interface PaymentFailedEvent extends DomainEvent<{
    paymentId: string;
    minerId: string;
    amount: number;
    reason: string;
    errorCode: string;
    willRetry: boolean;
}> {
    type: 'payment.failed';
}

// Aggregate for event sourcing
export abstract class AggregateRoot {
    protected version = 0;
    protected uncommittedEvents: DomainEvent[] = [];

    constructor(protected readonly id: string) {}

    public getId(): string {
        return this.id;
    }

    public getVersion(): number {
        return this.version;
    }

    public getUncommittedEvents(): DomainEvent[] {
        return this.uncommittedEvents;
    }

    public markEventsAsCommitted(): void {
        this.uncommittedEvents = [];
    }

    public loadFromHistory(events: DomainEvent[]): void {
        for (const event of events) {
            this.applyEvent(event, false);
        }
    }

    protected applyEvent(event: DomainEvent, isNew: boolean = true): void {
        // Apply event to aggregate state
        const handler = this.getEventHandler(event.type);
        if (handler) {
            handler.call(this, event);
        }

        if (isNew) {
            this.uncommittedEvents.push(event);
        }

        this.version++;
    }

    protected abstract getEventHandler(eventType: string): Function | undefined;

    protected createEvent<T>(
        type: string,
        payload: T,
        metadata?: EventMetadata
    ): DomainEvent<T> {
        return {
            id: this.generateEventId(),
            type,
            source: this.constructor.name,
            timestamp: new Date(),
            version: '1.0',
            aggregateId: this.id,
            aggregateType: this.constructor.name,
            aggregateVersion: this.version + 1,
            data: payload,
            payload,
            metadata
        };
    }

    private generateEventId(): string {
        return `${this.constructor.name}-${this.id}-${Date.now()}`;
    }
}

// Example: Miner Aggregate
export class MinerAggregate extends AggregateRoot {
    private address: string = '';
    private isConnected: boolean = false;
    private isBanned: boolean = false;
    private totalShares: number = 0;
    private acceptedShares: number = 0;
    private rejectedShares: number = 0;
    private lastSeenAt?: Date;

    public static create(minerId: string, address: string): MinerAggregate {
        const miner = new MinerAggregate(minerId);
        miner.connect(address, '127.0.0.1', 'test-agent', '1.0.0');
        return miner;
    }

    public connect(address: string, ipAddress: string, userAgent: string, version: string): void {
        if (this.isConnected) {
            throw new Error('Miner already connected');
        }

        if (this.isBanned) {
            throw new Error('Miner is banned');
        }

        const event = this.createEvent<any>('miner.connected', {
            minerId: this.id,
            address,
            ipAddress,
            userAgent,
            version,
            timestamp: new Date()
        });

        this.applyEvent(event);
    }

    public disconnect(reason: string): void {
        if (!this.isConnected) {
            throw new Error('Miner not connected');
        }

        const duration = this.lastSeenAt 
            ? Date.now() - this.lastSeenAt.getTime() 
            : 0;

        const event = this.createEvent<any>('miner.disconnected', {
            minerId: this.id,
            address: this.address,
            reason,
            duration,
            sharesSubmitted: this.totalShares
        });

        this.applyEvent(event);
    }

    public submitShare(shareId: string, workerId: string, jobId: string, nonce: string, difficulty: number): void {
        if (!this.isConnected) {
            throw new Error('Miner not connected');
        }

        const event = this.createEvent<any>('share.submitted', {
            shareId,
            minerId: this.id,
            workerId,
            jobId,
            nonce,
            difficulty,
            timestamp: new Date()
        });

        this.applyEvent(event);
    }

    public acceptShare(shareId: string, workerId: string, difficulty: number, reward: number): void {
        const event = this.createEvent<any>('share.accepted', {
            shareId,
            minerId: this.id,
            workerId,
            difficulty,
            reward
        });

        this.applyEvent(event);
    }

    public rejectShare(shareId: string, workerId: string, reason: string, errorCode: string): void {
        const event = this.createEvent<any>('share.rejected', {
            shareId,
            minerId: this.id,
            workerId,
            reason,
            errorCode
        });

        this.applyEvent(event);
    }

    public ban(reason: string, bannedBy: string, duration?: number): void {
        if (this.isBanned) {
            throw new Error('Miner already banned');
        }

        const event = this.createEvent<any>('miner.banned', {
            minerId: this.id,
            address: this.address,
            reason,
            bannedBy,
            duration,
            permanent: !duration
        });

        this.applyEvent(event);
    }

    // Event handlers
    protected getEventHandler(eventType: string): Function | undefined {
        const handlers: Record<string, Function> = {
            'miner.connected': this.onMinerConnected,
            'miner.disconnected': this.onMinerDisconnected,
            'share.submitted': this.onShareSubmitted,
            'share.accepted': this.onShareAccepted,
            'share.rejected': this.onShareRejected,
            'miner.banned': this.onMinerBanned
        };

        return handlers[eventType];
    }

    private onMinerConnected(event: MinerConnectedEvent): void {
        this.address = event.payload.address;
        this.isConnected = true;
        this.lastSeenAt = new Date();
    }

    private onMinerDisconnected(event: MinerDisconnectedEvent): void {
        this.isConnected = false;
    }

    private onShareSubmitted(event: ShareSubmittedEvent): void {
        this.totalShares++;
        this.lastSeenAt = new Date();
    }

    private onShareAccepted(event: ShareAcceptedEvent): void {
        this.acceptedShares++;
    }

    private onShareRejected(event: ShareRejectedEvent): void {
        this.rejectedShares++;
    }

    private onMinerBanned(event: MinerBannedEvent): void {
        this.isBanned = true;
        this.isConnected = false;
    }

    // Getters
    public getAddress(): string {
        return this.address;
    }

    public getIsConnected(): boolean {
        return this.isConnected;
    }

    public getIsBanned(): boolean {
        return this.isBanned;
    }

    public getStats(): {
        totalShares: number;
        acceptedShares: number;
        rejectedShares: number;
        efficiency: number;
    } {
        const efficiency = this.totalShares > 0 
            ? (this.acceptedShares / this.totalShares) * 100 
            : 0;

        return {
            totalShares: this.totalShares,
            acceptedShares: this.acceptedShares,
            rejectedShares: this.rejectedShares,
            efficiency
        };
    }
}
