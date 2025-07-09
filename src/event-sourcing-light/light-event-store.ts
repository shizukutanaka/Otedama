/**
 * 軽量イベントソーシング基盤
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import * as readline from 'readline';

// === 型定義 ===
export interface Event {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  version: number;
  timestamp: number;
  data: any;
  metadata: Record<string, any>;
  checksum: string;
}

export interface Snapshot {
  aggregateId: string;
  aggregateType: string;
  version: number;
  timestamp: number;
  data: any;
  checksum: string;
}

export interface EventFilter {
  aggregateId?: string;
  aggregateType?: string;
  eventType?: string;
  fromVersion?: number;
  toVersion?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
}

export interface Aggregate {
  id: string;
  type: string;
  version: number;
  uncommittedEvents: Event[];
  applyEvent(event: Event): void;
  getSnapshot(): any;
  loadFromSnapshot(snapshot: any): void;
}

export interface EventHandler {
  eventType: string;
  handle(event: Event): Promise<void>;
}

export interface Projection {
  name: string;
  version: number;
  handle(event: Event): Promise<void>;
  rebuild?(events: Event[]): Promise<void>;
}

// === 軽量イベントストア ===
export class LightEventStore extends EventEmitter {
  private events = new Map<string, Event[]>(); // aggregateId -> events
  private snapshots = new Map<string, Snapshot>(); // aggregateId -> snapshot
  private eventHandlers = new Map<string, EventHandler[]>(); // eventType -> handlers
  private projections = new Map<string, Projection>(); // name -> projection
  private persistencePath: string;
  private isInitialized = false;

  constructor(persistencePath = './data/events') {
    super();
    this.persistencePath = persistencePath;
    this.ensureDirectoryExists();
  }

  // === 初期化 ===
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await this.loadEvents();
    await this.loadSnapshots();
    this.isInitialized = true;
    this.emit('initialized');
  }

  private ensureDirectoryExists(): void {
    if (!existsSync(this.persistencePath)) {
      mkdirSync(this.persistencePath, { recursive: true });
    }
    
    const eventsDir = join(this.persistencePath, 'events');
    const snapshotsDir = join(this.persistencePath, 'snapshots');
    
    if (!existsSync(eventsDir)) {
      mkdirSync(eventsDir, { recursive: true });
    }
    
    if (!existsSync(snapshotsDir)) {
      mkdirSync(snapshotsDir, { recursive: true });
    }
  }

  // === イベント管理 ===
  async appendEvent(event: Omit<Event, 'id' | 'timestamp' | 'checksum'>): Promise<Event> {
    const newEvent: Event = {
      ...event,
      id: this.generateEventId(),
      timestamp: Date.now(),
      checksum: this.calculateChecksum(event)
    };

    // メモリに追加
    const events = this.events.get(event.aggregateId) || [];
    events.push(newEvent);
    this.events.set(event.aggregateId, events);

    // ディスクに永続化
    await this.persistEvent(newEvent);

    // イベントハンドラーを呼び出し
    await this.processEvent(newEvent);

    this.emit('eventAppended', newEvent);
    return newEvent;
  }

  async appendEvents(events: Omit<Event, 'id' | 'timestamp' | 'checksum'>[]): Promise<Event[]> {
    const newEvents: Event[] = [];

    for (const event of events) {
      const newEvent = await this.appendEvent(event);
      newEvents.push(newEvent);
    }

    return newEvents;
  }

  async getEvents(filter: EventFilter = {}): Promise<Event[]> {
    let allEvents: Event[] = [];

    if (filter.aggregateId) {
      const events = this.events.get(filter.aggregateId) || [];
      allEvents = [...events];
    } else {
      for (const events of this.events.values()) {
        allEvents.push(...events);
      }
    }

    // フィルタリング
    return this.applyFilter(allEvents, filter);
  }

  async getEventsFromVersion(aggregateId: string, fromVersion: number): Promise<Event[]> {
    const events = this.events.get(aggregateId) || [];
    return events.filter(e => e.version >= fromVersion);
  }

  // === スナップショット管理 ===
  async saveSnapshot(snapshot: Omit<Snapshot, 'checksum'>): Promise<Snapshot> {
    const newSnapshot: Snapshot = {
      ...snapshot,
      checksum: this.calculateSnapshotChecksum(snapshot)
    };

    this.snapshots.set(snapshot.aggregateId, newSnapshot);
    await this.persistSnapshot(newSnapshot);

    this.emit('snapshotSaved', newSnapshot);
    return newSnapshot;
  }

  async getSnapshot(aggregateId: string): Promise<Snapshot | null> {
    return this.snapshots.get(aggregateId) || null;
  }

  async getLatestSnapshot(aggregateId: string): Promise<Snapshot | null> {
    const snapshot = this.snapshots.get(aggregateId);
    if (!snapshot) return null;

    // 整合性チェック
    const calculatedChecksum = this.calculateSnapshotChecksum(snapshot);
    if (calculatedChecksum !== snapshot.checksum) {
      console.warn(`Snapshot checksum mismatch for ${aggregateId}`);
      return null;
    }

    return snapshot;
  }

  // === アグリゲート管理 ===
  async loadAggregate<T extends Aggregate>(
    aggregateId: string,
    aggregateType: string,
    createFn: () => T
  ): Promise<T> {
    const aggregate = createFn();
    aggregate.id = aggregateId;
    aggregate.type = aggregateType;

    // スナップショットから復元を試行
    const snapshot = await this.getLatestSnapshot(aggregateId);
    let fromVersion = 0;

    if (snapshot) {
      aggregate.loadFromSnapshot(snapshot.data);
      aggregate.version = snapshot.version;
      fromVersion = snapshot.version + 1;
    }

    // スナップショット以降のイベントを適用
    const events = await this.getEventsFromVersion(aggregateId, fromVersion);
    for (const event of events) {
      aggregate.applyEvent(event);
      aggregate.version = event.version;
    }

    return aggregate;
  }

  async saveAggregate(aggregate: Aggregate): Promise<void> {
    if (aggregate.uncommittedEvents.length === 0) {
      return;
    }

    // 未コミットイベントを永続化
    for (const event of aggregate.uncommittedEvents) {
      await this.appendEvent({
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        eventType: event.eventType,
        version: event.version,
        data: event.data,
        metadata: event.metadata
      });
    }

    // 未コミットイベントをクリア
    aggregate.uncommittedEvents = [];

    // 定期的にスナップショットを作成
    if (aggregate.version % 100 === 0) {
      await this.saveSnapshot({
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        version: aggregate.version,
        timestamp: Date.now(),
        data: aggregate.getSnapshot()
      });
    }
  }

  // === イベントハンドラー ===
  addEventHandler(handler: EventHandler): void {
    const handlers = this.eventHandlers.get(handler.eventType) || [];
    handlers.push(handler);
    this.eventHandlers.set(handler.eventType, handlers);
  }

  removeEventHandler(handler: EventHandler): boolean {
    const handlers = this.eventHandlers.get(handler.eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  private async processEvent(event: Event): Promise<void> {
    const handlers = this.eventHandlers.get(event.eventType) || [];
    
    await Promise.allSettled(
      handlers.map(handler => 
        handler.handle(event).catch(error => 
          console.error(`Event handler error for ${event.eventType}:`, error)
        )
      )
    );

    // プロジェクションを更新
    await this.updateProjections(event);
  }

  // === プロジェクション ===
  addProjection(projection: Projection): void {
    this.projections.set(projection.name, projection);
  }

  removeProjection(name: string): boolean {
    return this.projections.delete(name);
  }

  async rebuildProjection(name: string): Promise<void> {
    const projection = this.projections.get(name);
    if (!projection || !projection.rebuild) {
      throw new Error(`Projection ${name} not found or not rebuildable`);
    }

    const allEvents = await this.getEvents();
    await projection.rebuild(allEvents);
  }

  private async updateProjections(event: Event): Promise<void> {
    const updatePromises = Array.from(this.projections.values()).map(projection =>
      projection.handle(event).catch(error =>
        console.error(`Projection update error for ${projection.name}:`, error)
      )
    );

    await Promise.allSettled(updatePromises);
  }

  // === 永続化 ===
  private async persistEvent(event: Event): Promise<void> {
    const eventPath = join(this.persistencePath, 'events', `${event.aggregateId}.json`);
    const eventLine = JSON.stringify(event) + '\n';
    
    const stream = createWriteStream(eventPath, { flags: 'a' });
    stream.write(eventLine);
    stream.end();
  }

  private async persistSnapshot(snapshot: Snapshot): Promise<void> {
    const snapshotPath = join(this.persistencePath, 'snapshots', `${snapshot.aggregateId}.json`);
    const snapshotData = JSON.stringify(snapshot, null, 2);
    
    const stream = createWriteStream(snapshotPath);
    stream.write(snapshotData);
    stream.end();
  }

  private async loadEvents(): Promise<void> {
    const eventsDir = join(this.persistencePath, 'events');
    if (!existsSync(eventsDir)) return;

    const fs = require('fs').promises;
    const files = await fs.readdir(eventsDir);

    for (const file of files) {
      if (file.endsWith('.json')) {
        const aggregateId = file.replace('.json', '');
        const filePath = join(eventsDir, file);
        
        const events = await this.readEventsFromFile(filePath);
        if (events.length > 0) {
          this.events.set(aggregateId, events);
        }
      }
    }
  }

  private async readEventsFromFile(filePath: string): Promise<Event[]> {
    const events: Event[] = [];
    
    if (!existsSync(filePath)) return events;

    const fileStream = createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          events.push(event);
        } catch (error) {
          console.error(`Error parsing event line: ${line}`, error);
        }
      }
    }

    return events;
  }

  private async loadSnapshots(): Promise<void> {
    const snapshotsDir = join(this.persistencePath, 'snapshots');
    if (!existsSync(snapshotsDir)) return;

    const fs = require('fs').promises;
    const files = await fs.readdir(snapshotsDir);

    for (const file of files) {
      if (file.endsWith('.json')) {
        const aggregateId = file.replace('.json', '');
        const filePath = join(snapshotsDir, file);
        
        try {
          const data = await fs.readFile(filePath, 'utf8');
          const snapshot = JSON.parse(data);
          this.snapshots.set(aggregateId, snapshot);
        } catch (error) {
          console.error(`Error loading snapshot ${file}:`, error);
        }
      }
    }
  }

  // === ユーティリティ ===
  private generateEventId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2);
    return createHash('sha256').update(timestamp + random).digest('hex').substring(0, 16);
  }

  private calculateChecksum(event: any): string {
    const data = {
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      eventType: event.eventType,
      version: event.version,
      data: event.data
    };
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  private calculateSnapshotChecksum(snapshot: any): string {
    const data = {
      aggregateId: snapshot.aggregateId,
      aggregateType: snapshot.aggregateType,
      version: snapshot.version,
      data: snapshot.data
    };
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  private applyFilter(events: Event[], filter: EventFilter): Event[] {
    let filtered = [...events];

    if (filter.aggregateType) {
      filtered = filtered.filter(e => e.aggregateType === filter.aggregateType);
    }

    if (filter.eventType) {
      filtered = filtered.filter(e => e.eventType === filter.eventType);
    }

    if (filter.fromVersion !== undefined) {
      filtered = filtered.filter(e => e.version >= filter.fromVersion!);
    }

    if (filter.toVersion !== undefined) {
      filtered = filtered.filter(e => e.version <= filter.toVersion!);
    }

    if (filter.fromTimestamp !== undefined) {
      filtered = filtered.filter(e => e.timestamp >= filter.fromTimestamp!);
    }

    if (filter.toTimestamp !== undefined) {
      filtered = filtered.filter(e => e.timestamp <= filter.toTimestamp!);
    }

    // 時系列順にソート
    filtered.sort((a, b) => a.timestamp - b.timestamp);

    if (filter.limit !== undefined) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  // === 統計・情報取得 ===
  getStats() {
    const totalEvents = Array.from(this.events.values()).reduce((sum, events) => sum + events.length, 0);
    const totalAggregates = this.events.size;
    const totalSnapshots = this.snapshots.size;
    const totalHandlers = Array.from(this.eventHandlers.values()).reduce((sum, handlers) => sum + handlers.length, 0);
    const totalProjections = this.projections.size;

    return {
      totalEvents,
      totalAggregates,
      totalSnapshots,
      totalHandlers,
      totalProjections,
      eventTypes: Array.from(this.eventHandlers.keys()),
      projectionNames: Array.from(this.projections.keys())
    };
  }

  async cleanup(): Promise<void> {
    // 古いスナップショットの削除など
    // 実装は用途に応じて
  }
}

// === 基底アグリゲートクラス ===
export abstract class BaseAggregate implements Aggregate {
  public id: string = '';
  public type: string = '';
  public version: number = 0;
  public uncommittedEvents: Event[] = [];

  protected addEvent(eventType: string, data: any, metadata: Record<string, any> = {}): void {
    const event: Event = {
      id: '',
      aggregateId: this.id,
      aggregateType: this.type,
      eventType,
      version: this.version + 1,
      timestamp: Date.now(),
      data,
      metadata,
      checksum: ''
    };

    this.uncommittedEvents.push(event);
    this.applyEvent(event);
    this.version++;
  }

  abstract applyEvent(event: Event): void;
  abstract getSnapshot(): any;
  abstract loadFromSnapshot(snapshot: any): void;
}

// === ヘルパークラス ===
export class EventStoreHelper {
  static createMiningPoolAggregate(poolId: string): MiningPoolAggregate {
    const aggregate = new MiningPoolAggregate();
    aggregate.id = poolId;
    aggregate.type = 'MiningPool';
    return aggregate;
  }

  static createMinerAggregate(minerId: string): MinerAggregate {
    const aggregate = new MinerAggregate();
    aggregate.id = minerId;
    aggregate.type = 'Miner';
    return aggregate;
  }
}

// === マイニングプール用アグリゲート例 ===
export class MiningPoolAggregate extends BaseAggregate {
  private totalShares = 0;
  private blocksFound = 0;
  private totalPayout = 0;
  private miners = new Set<string>();

  applyEvent(event: Event): void {
    switch (event.eventType) {
      case 'ShareSubmitted':
        this.totalShares++;
        this.miners.add(event.data.minerId);
        break;
      case 'BlockFound':
        this.blocksFound++;
        break;
      case 'PayoutProcessed':
        this.totalPayout += event.data.amount;
        break;
    }
  }

  getSnapshot(): any {
    return {
      totalShares: this.totalShares,
      blocksFound: this.blocksFound,
      totalPayout: this.totalPayout,
      miners: Array.from(this.miners)
    };
  }

  loadFromSnapshot(snapshot: any): void {
    this.totalShares = snapshot.totalShares || 0;
    this.blocksFound = snapshot.blocksFound || 0;
    this.totalPayout = snapshot.totalPayout || 0;
    this.miners = new Set(snapshot.miners || []);
  }

  // ビジネスロジック
  submitShare(minerId: string, difficulty: number, valid: boolean): void {
    this.addEvent('ShareSubmitted', {
      minerId,
      difficulty,
      valid,
      timestamp: Date.now()
    });
  }

  findBlock(minerId: string, blockHash: string, reward: number): void {
    this.addEvent('BlockFound', {
      minerId,
      blockHash,
      reward,
      timestamp: Date.now()
    });
  }

  processPayout(payments: Array<{ minerId: string; amount: number }>): void {
    const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);
    this.addEvent('PayoutProcessed', {
      payments,
      totalAmount,
      timestamp: Date.now()
    });
  }

  // ゲッター
  getTotalShares(): number {
    return this.totalShares;
  }

  getBlocksFound(): number {
    return this.blocksFound;
  }

  getTotalPayout(): number {
    return this.totalPayout;
  }

  getActiveMiners(): string[] {
    return Array.from(this.miners);
  }
}

// === マイナー用アグリゲート例 ===
export class MinerAggregate extends BaseAggregate {
  private shares = 0;
  private validShares = 0;
  private balance = 0;
  private totalPaid = 0;
  private joinDate = 0;

  applyEvent(event: Event): void {
    switch (event.eventType) {
      case 'MinerJoined':
        this.joinDate = event.timestamp;
        break;
      case 'ShareSubmitted':
        this.shares++;
        if (event.data.valid) {
          this.validShares++;
        }
        break;
      case 'BalanceUpdated':
        this.balance = event.data.newBalance;
        break;
      case 'PaymentSent':
        this.balance -= event.data.amount;
        this.totalPaid += event.data.amount;
        break;
    }
  }

  getSnapshot(): any {
    return {
      shares: this.shares,
      validShares: this.validShares,
      balance: this.balance,
      totalPaid: this.totalPaid,
      joinDate: this.joinDate
    };
  }

  loadFromSnapshot(snapshot: any): void {
    this.shares = snapshot.shares || 0;
    this.validShares = snapshot.validShares || 0;
    this.balance = snapshot.balance || 0;
    this.totalPaid = snapshot.totalPaid || 0;
    this.joinDate = snapshot.joinDate || 0;
  }

  // ビジネスロジック
  join(): void {
    this.addEvent('MinerJoined', {
      timestamp: Date.now()
    });
  }

  submitShare(difficulty: number, valid: boolean): void {
    this.addEvent('ShareSubmitted', {
      difficulty,
      valid,
      timestamp: Date.now()
    });
  }

  updateBalance(newBalance: number): void {
    this.addEvent('BalanceUpdated', {
      oldBalance: this.balance,
      newBalance,
      timestamp: Date.now()
    });
  }

  sendPayment(amount: number, txHash: string): void {
    this.addEvent('PaymentSent', {
      amount,
      txHash,
      timestamp: Date.now()
    });
  }

  // ゲッター
  getShares(): number {
    return this.shares;
  }

  getValidShares(): number {
    return this.validShares;
  }

  getBalance(): number {
    return this.balance;
  }

  getTotalPaid(): number {
    return this.totalPaid;
  }

  getSuccessRate(): number {
    return this.shares > 0 ? this.validShares / this.shares : 0;
  }
}

export default LightEventStore;