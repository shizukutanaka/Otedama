/**
 * ピア評価システム
 * P2Pネットワークにおける信頼性スコアリング
 * 
 * 設計思想：
 * - Carmack: 効率的なリアルタイム評価
 * - Martin: 拡張可能な評価基準
 * - Pike: シンプルで公平な評価アルゴリズム
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface PeerEvaluationConfig {
  // 評価パラメータ
  initialScore: number;           // 初期スコア（0-100）
  maxScore: number;              // 最大スコア
  minScore: number;              // 最小スコア
  
  // 重み設定
  weights: {
    shareValidity: number;       // シェア有効性の重み
    responseTime: number;        // 応答時間の重み
    uptime: number;             // 稼働時間の重み
    dataQuality: number;        // データ品質の重み
    contribution: number;       // 貢献度の重み
  };
  
  // 閾値設定
  banThreshold: number;          // BAN閾値
  suspicionThreshold: number;    // 疑わしい動作の閾値
  trustedThreshold: number;      // 信頼されるピアの閾値
  
  // 減衰設定
  decayRate: number;            // スコア減衰率（時間経過）
  recoveryRate: number;         // スコア回復率
  
  // 評価間隔
  evaluationInterval: number;    // 評価更新間隔（秒）
  historyWindow: number;        // 履歴保持期間（秒）
}

export interface PeerMetrics {
  // 基本情報
  peerId: string;
  address: string;
  firstSeen: number;
  lastSeen: number;
  
  // パフォーマンスメトリクス
  totalShares: number;
  validShares: number;
  invalidShares: number;
  orphanShares: number;
  
  // ネットワークメトリクス
  averageLatency: number;       // 平均レイテンシー（ms）
  packetLoss: number;          // パケットロス率（％）
  bandwidth: number;           // 帯域幅（bps）
  
  // 行動メトリクス
  requestsServed: number;      // 処理したリクエスト数
  requestsDenied: number;      // 拒否したリクエスト数
  dataShared: number;         // 共有したデータ量（bytes）
  
  // 信頼性メトリクス
  uptimePercent: number;      // 稼働率（％）
  consistencyScore: number;   // データ一貫性スコア
  protocolCompliance: number; // プロトコル準拠率
  
  // 異常検知
  suspiciousActivities: number; // 疑わしい活動の回数
  violations: string[];        // 違反のリスト
}

export interface PeerScore {
  peerId: string;
  currentScore: number;
  components: {
    validity: number;          // 有効性スコア
    performance: number;       // パフォーマンススコア
    reliability: number;       // 信頼性スコア
    contribution: number;      // 貢献度スコア
    behavior: number;         // 行動スコア
  };
  trend: 'improving' | 'stable' | 'declining';
  status: 'trusted' | 'normal' | 'suspicious' | 'banned';
  lastUpdate: number;
}

export interface PeerEvent {
  peerId: string;
  type: 'share' | 'request' | 'response' | 'violation' | 'connection' | 'disconnection';
  timestamp: number;
  data: any;
  impact: number;              // スコアへの影響（-100 to +100）
}

export interface EvaluationResult {
  peerId: string;
  oldScore: number;
  newScore: number;
  reason: string;
  actions: string[];           // 実行すべきアクション
}

// === ピア評価マネージャー ===
export class PeerEvaluationManager extends EventEmitter {
  private config: PeerEvaluationConfig;
  private peerMetrics: Map<string, PeerMetrics> = new Map();
  private peerScores: Map<string, PeerScore> = new Map();
  private peerEvents: Map<string, PeerEvent[]> = new Map();
  private evaluationTimer?: NodeJS.Timeout;
  
  // 統計情報
  private statistics = {
    totalPeers: 0,
    trustedPeers: 0,
    normalPeers: 0,
    suspiciousPeers: 0,
    bannedPeers: 0,
    averageScore: 0
  };
  
  constructor(config: PeerEvaluationConfig) {
    super();
    this.config = config;
  }
  
  // システムの開始
  start(): void {
    this.evaluationTimer = setInterval(
      () => this.evaluateAllPeers(),
      this.config.evaluationInterval * 1000
    );
    
    // 履歴のクリーンアップ
    setInterval(
      () => this.cleanupHistory(),
      this.config.historyWindow * 1000
    );
    
    this.emit('started');
  }
  
  // システムの停止
  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = undefined;
    }
    
    this.emit('stopped');
  }
  
  // ピアの登録
  registerPeer(peerId: string, address: string): void {
    if (this.peerMetrics.has(peerId)) {
      return;
    }
    
    const now = Date.now();
    
    // 初期メトリクス
    const metrics: PeerMetrics = {
      peerId,
      address,
      firstSeen: now,
      lastSeen: now,
      totalShares: 0,
      validShares: 0,
      invalidShares: 0,
      orphanShares: 0,
      averageLatency: 0,
      packetLoss: 0,
      bandwidth: 0,
      requestsServed: 0,
      requestsDenied: 0,
      dataShared: 0,
      uptimePercent: 100,
      consistencyScore: 100,
      protocolCompliance: 100,
      suspiciousActivities: 0,
      violations: []
    };
    
    // 初期スコア
    const score: PeerScore = {
      peerId,
      currentScore: this.config.initialScore,
      components: {
        validity: this.config.initialScore,
        performance: this.config.initialScore,
        reliability: this.config.initialScore,
        contribution: this.config.initialScore,
        behavior: this.config.initialScore
      },
      trend: 'stable',
      status: 'normal',
      lastUpdate: now
    };
    
    this.peerMetrics.set(peerId, metrics);
    this.peerScores.set(peerId, score);
    this.peerEvents.set(peerId, []);
    
    this.emit('peerRegistered', { peerId, address });
  }
  
  // イベントの記録
  recordEvent(event: PeerEvent): void {
    const events = this.peerEvents.get(event.peerId) || [];
    events.push(event);
    this.peerEvents.set(event.peerId, events);
    
    // 即座の評価が必要な場合
    if (Math.abs(event.impact) > 50) {
      this.evaluatePeer(event.peerId);
    }
    
    // メトリクスの更新
    this.updateMetricsFromEvent(event);
  }
  
  // シェア提出の記録
  recordShareSubmission(
    peerId: string,
    valid: boolean,
    difficulty: number,
    latency: number
  ): void {
    const metrics = this.peerMetrics.get(peerId);
    if (!metrics) return;
    
    metrics.totalShares++;
    if (valid) {
      metrics.validShares++;
    } else {
      metrics.invalidShares++;
    }
    
    // レイテンシーの更新（移動平均）
    metrics.averageLatency = metrics.averageLatency * 0.9 + latency * 0.1;
    metrics.lastSeen = Date.now();
    
    // イベントの記録
    const impact = valid ? difficulty / 1000 : -20; // 有効なシェアは難易度に応じて加点
    this.recordEvent({
      peerId,
      type: 'share',
      timestamp: Date.now(),
      data: { valid, difficulty, latency },
      impact
    });
  }
  
  // データリクエストの記録
  recordDataRequest(
    peerId: string,
    served: boolean,
    dataSize: number,
    responseTime: number
  ): void {
    const metrics = this.peerMetrics.get(peerId);
    if (!metrics) return;
    
    if (served) {
      metrics.requestsServed++;
      metrics.dataShared += dataSize;
    } else {
      metrics.requestsDenied++;
    }
    
    metrics.lastSeen = Date.now();
    
    // イベントの記録
    const impact = served ? Math.min(dataSize / 10000, 10) : -5;
    this.recordEvent({
      peerId,
      type: 'request',
      timestamp: Date.now(),
      data: { served, dataSize, responseTime },
      impact
    });
  }
  
  // プロトコル違反の記録
  recordViolation(peerId: string, violationType: string, severity: number): void {
    const metrics = this.peerMetrics.get(peerId);
    if (!metrics) return;
    
    metrics.violations.push(violationType);
    metrics.suspiciousActivities++;
    metrics.protocolCompliance = Math.max(0, metrics.protocolCompliance - severity);
    
    // イベントの記録
    this.recordEvent({
      peerId,
      type: 'violation',
      timestamp: Date.now(),
      data: { violationType, severity },
      impact: -severity
    });
    
    // 即座の評価
    this.evaluatePeer(peerId);
  }
  
  // 単一ピアの評価
  private evaluatePeer(peerId: string): EvaluationResult | null {
    const metrics = this.peerMetrics.get(peerId);
    const score = this.peerScores.get(peerId);
    const events = this.peerEvents.get(peerId) || [];
    
    if (!metrics || !score) return null;
    
    const oldScore = score.currentScore;
    
    // コンポーネントスコアの計算
    score.components.validity = this.calculateValidityScore(metrics);
    score.components.performance = this.calculatePerformanceScore(metrics);
    score.components.reliability = this.calculateReliabilityScore(metrics);
    score.components.contribution = this.calculateContributionScore(metrics, events);
    score.components.behavior = this.calculateBehaviorScore(metrics, events);
    
    // 重み付き総合スコアの計算
    const weights = this.config.weights;
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    
    score.currentScore = (
      score.components.validity * weights.shareValidity +
      score.components.performance * weights.responseTime +
      score.components.reliability * weights.uptime +
      score.components.contribution * weights.contribution +
      score.components.behavior * weights.dataQuality
    ) / totalWeight;
    
    // スコアの制限
    score.currentScore = Math.max(this.config.minScore, 
                                  Math.min(this.config.maxScore, score.currentScore));
    
    // トレンドの判定
    const scoreDiff = score.currentScore - oldScore;
    if (scoreDiff > 5) {
      score.trend = 'improving';
    } else if (scoreDiff < -5) {
      score.trend = 'declining';
    } else {
      score.trend = 'stable';
    }
    
    // ステータスの判定
    const actions: string[] = [];
    if (score.currentScore < this.config.banThreshold) {
      score.status = 'banned';
      actions.push('ban_peer');
    } else if (score.currentScore < this.config.suspicionThreshold) {
      score.status = 'suspicious';
      actions.push('limit_resources');
    } else if (score.currentScore > this.config.trustedThreshold) {
      score.status = 'trusted';
      actions.push('increase_priority');
    } else {
      score.status = 'normal';
    }
    
    score.lastUpdate = Date.now();
    
    const result: EvaluationResult = {
      peerId,
      oldScore,
      newScore: score.currentScore,
      reason: this.getEvaluationReason(score, metrics),
      actions
    };
    
    this.emit('peerEvaluated', result);
    
    return result;
  }
  
  // 有効性スコアの計算
  private calculateValidityScore(metrics: PeerMetrics): number {
    if (metrics.totalShares === 0) {
      return this.config.initialScore;
    }
    
    const validityRate = metrics.validShares / metrics.totalShares;
    const orphanRate = metrics.orphanShares / metrics.totalShares;
    
    // 有効率が高いほど高スコア、オーファン率が高いほど低スコア
    let score = validityRate * 100;
    score -= orphanRate * 20;
    
    return Math.max(0, Math.min(100, score));
  }
  
  // パフォーマンススコアの計算
  private calculatePerformanceScore(metrics: PeerMetrics): number {
    // レイテンシーに基づくスコア（低いほど良い）
    const latencyScore = Math.max(0, 100 - metrics.averageLatency / 10);
    
    // パケットロスに基づくスコア
    const lossScore = Math.max(0, 100 - metrics.packetLoss * 5);
    
    // 帯域幅に基づくスコア（対数スケール）
    const bandwidthScore = Math.min(100, Math.log10(metrics.bandwidth + 1) * 20);
    
    return (latencyScore + lossScore + bandwidthScore) / 3;
  }
  
  // 信頼性スコアの計算
  private calculateReliabilityScore(metrics: PeerMetrics): number {
    // 稼働率
    const uptimeScore = metrics.uptimePercent;
    
    // 一貫性スコア
    const consistencyScore = metrics.consistencyScore;
    
    // プロトコル準拠率
    const complianceScore = metrics.protocolCompliance;
    
    // 違反ペナルティ
    const violationPenalty = Math.min(50, metrics.violations.length * 10);
    
    return Math.max(0, (uptimeScore + consistencyScore + complianceScore) / 3 - violationPenalty);
  }
  
  // 貢献度スコアの計算
  private calculateContributionScore(metrics: PeerMetrics, events: PeerEvent[]): number {
    // リクエスト処理率
    const totalRequests = metrics.requestsServed + metrics.requestsDenied;
    const serveRate = totalRequests > 0 ? metrics.requestsServed / totalRequests : 0.5;
    
    // データ共有量（対数スケール）
    const dataScore = Math.min(50, Math.log10(metrics.dataShared + 1) * 5);
    
    // 最近の貢献
    const recentEvents = events.filter(e => 
      Date.now() - e.timestamp < this.config.historyWindow * 1000
    );
    
    const recentContribution = recentEvents
      .filter(e => e.type === 'request' && e.impact > 0)
      .reduce((sum, e) => sum + e.impact, 0);
    
    return Math.min(100, serveRate * 50 + dataScore + recentContribution / 10);
  }
  
  // 行動スコアの計算
  private calculateBehaviorScore(metrics: PeerMetrics, events: PeerEvent[]): number {
    let score = 100;
    
    // 疑わしい活動によるペナルティ
    score -= metrics.suspiciousActivities * 10;
    
    // 最近の悪い行動
    const recentEvents = events.filter(e => 
      Date.now() - e.timestamp < this.config.historyWindow * 1000
    );
    
    const negativeImpact = recentEvents
      .filter(e => e.impact < 0)
      .reduce((sum, e) => sum + Math.abs(e.impact), 0);
    
    score -= negativeImpact / 10;
    
    // プロトコル準拠ボーナス
    if (metrics.protocolCompliance >= 95) {
      score += 10;
    }
    
    return Math.max(0, Math.min(100, score));
  }
  
  // 評価理由の生成
  private getEvaluationReason(score: PeerScore, metrics: PeerMetrics): string {
    const reasons: string[] = [];
    
    // 各コンポーネントの評価
    if (score.components.validity < 50) {
      reasons.push(`Low validity rate: ${(metrics.validShares / metrics.totalShares * 100).toFixed(1)}%`);
    }
    
    if (score.components.performance < 50) {
      reasons.push(`Poor performance: ${metrics.averageLatency.toFixed(0)}ms latency`);
    }
    
    if (score.components.reliability < 50) {
      reasons.push(`Low reliability: ${metrics.violations.length} violations`);
    }
    
    if (score.components.contribution < 50) {
      reasons.push(`Low contribution: ${metrics.requestsServed} requests served`);
    }
    
    if (score.components.behavior < 50) {
      reasons.push(`Suspicious behavior: ${metrics.suspiciousActivities} incidents`);
    }
    
    return reasons.length > 0 ? reasons.join(', ') : 'Normal evaluation';
  }
  
  // 全ピアの評価
  private evaluateAllPeers(): void {
    const results: EvaluationResult[] = [];
    
    for (const [peerId] of this.peerScores) {
      const result = this.evaluatePeer(peerId);
      if (result) {
        results.push(result);
      }
    }
    
    // 統計の更新
    this.updateStatistics();
    
    // 時間減衰の適用
    this.applyTimeDecay();
    
    this.emit('evaluationCompleted', { results, statistics: this.statistics });
  }
  
  // 時間減衰の適用
  private applyTimeDecay(): void {
    const now = Date.now();
    
    for (const [peerId, score] of this.peerScores) {
      const metrics = this.peerMetrics.get(peerId);
      if (!metrics) continue;
      
      // 最後の活動からの経過時間
      const inactiveTime = now - metrics.lastSeen;
      const inactiveHours = inactiveTime / (1000 * 60 * 60);
      
      if (inactiveHours > 1) {
        // 非活動によるスコア減衰
        const decay = Math.min(inactiveHours * this.config.decayRate, 50);
        score.currentScore = Math.max(this.config.minScore, score.currentScore - decay);
        
        // 稼働率の更新
        const totalTime = now - metrics.firstSeen;
        const activeTime = totalTime - inactiveTime;
        metrics.uptimePercent = (activeTime / totalTime) * 100;
      }
    }
  }
  
  // イベントからメトリクスを更新
  private updateMetricsFromEvent(event: PeerEvent): void {
    const metrics = this.peerMetrics.get(event.peerId);
    if (!metrics) return;
    
    switch (event.type) {
      case 'share':
        // シェアイベントは既に処理済み
        break;
        
      case 'response':
        // 応答時間の更新
        if (event.data.responseTime) {
          metrics.averageLatency = metrics.averageLatency * 0.9 + event.data.responseTime * 0.1;
        }
        break;
        
      case 'violation':
        // 違反は既に処理済み
        break;
        
      case 'connection':
        metrics.lastSeen = event.timestamp;
        break;
        
      case 'disconnection':
        // 切断時の処理
        break;
    }
  }
  
  // 履歴のクリーンアップ
  private cleanupHistory(): void {
    const cutoff = Date.now() - this.config.historyWindow * 1000;
    
    for (const [peerId, events] of this.peerEvents) {
      const filtered = events.filter(e => e.timestamp > cutoff);
      this.peerEvents.set(peerId, filtered);
    }
  }
  
  // 統計の更新
  private updateStatistics(): void {
    this.statistics = {
      totalPeers: this.peerScores.size,
      trustedPeers: 0,
      normalPeers: 0,
      suspiciousPeers: 0,
      bannedPeers: 0,
      averageScore: 0
    };
    
    let totalScore = 0;
    
    for (const score of this.peerScores.values()) {
      totalScore += score.currentScore;
      
      switch (score.status) {
        case 'trusted':
          this.statistics.trustedPeers++;
          break;
        case 'normal':
          this.statistics.normalPeers++;
          break;
        case 'suspicious':
          this.statistics.suspiciousPeers++;
          break;
        case 'banned':
          this.statistics.bannedPeers++;
          break;
      }
    }
    
    if (this.statistics.totalPeers > 0) {
      this.statistics.averageScore = totalScore / this.statistics.totalPeers;
    }
  }
  
  // 公開API
  getPeerScore(peerId: string): PeerScore | null {
    return this.peerScores.get(peerId) || null;
  }
  
  getPeerMetrics(peerId: string): PeerMetrics | null {
    return this.peerMetrics.get(peerId) || null;
  }
  
  getAllScores(): PeerScore[] {
    return Array.from(this.peerScores.values());
  }
  
  getTrustedPeers(): string[] {
    return Array.from(this.peerScores.entries())
      .filter(([_, score]) => score.status === 'trusted')
      .map(([peerId]) => peerId);
  }
  
  getBannedPeers(): string[] {
    return Array.from(this.peerScores.entries())
      .filter(([_, score]) => score.status === 'banned')
      .map(([peerId]) => peerId);
  }
  
  getStatistics(): typeof this.statistics {
    return { ...this.statistics };
  }
  
  // 手動でピアをBANする
  banPeer(peerId: string, reason: string): void {
    const score = this.peerScores.get(peerId);
    if (score) {
      score.currentScore = 0;
      score.status = 'banned';
      
      this.recordViolation(peerId, `Manual ban: ${reason}`, 100);
      
      this.emit('peerBanned', { peerId, reason });
    }
  }
  
  // ピアの信頼度を手動で設定
  trustPeer(peerId: string): void {
    const score = this.peerScores.get(peerId);
    if (score) {
      score.currentScore = Math.max(score.currentScore, this.config.trustedThreshold);
      score.status = 'trusted';
      
      this.emit('peerTrusted', { peerId });
    }
  }
  
  // ピアのリセット
  resetPeer(peerId: string): void {
    const score = this.peerScores.get(peerId);
    if (score) {
      score.currentScore = this.config.initialScore;
      score.status = 'normal';
      score.components = {
        validity: this.config.initialScore,
        performance: this.config.initialScore,
        reliability: this.config.initialScore,
        contribution: this.config.initialScore,
        behavior: this.config.initialScore
      };
      
      // メトリクスの一部をリセット
      const metrics = this.peerMetrics.get(peerId);
      if (metrics) {
        metrics.violations = [];
        metrics.suspiciousActivities = 0;
        metrics.protocolCompliance = 100;
      }
      
      this.emit('peerReset', { peerId });
    }
  }
}

export default PeerEvaluationManager;