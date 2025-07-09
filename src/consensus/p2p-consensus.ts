/**
 * P2Pコンセンサスメカニズム
 * 分散型マイニングプールの合意形成システム
 * 
 * 設計思想：
 * - Carmack: 効率的で低レイテンシーな合意形成
 * - Martin: 拡張可能なコンセンサスアーキテクチャ
 * - Pike: シンプルで理解しやすい合意アルゴリズム
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// === 型定義 ===
export interface ConsensusConfig {
  // 基本設定
  minPeers: number;              // 最小ピア数
  consensusThreshold: number;     // 合意閾値（％）
  blockTime: number;             // ブロック時間（秒）
  shareWindow: number;           // シェアウィンドウサイズ
  
  // タイムアウト設定
  proposalTimeout: number;       // 提案タイムアウト（秒）
  voteTimeout: number;          // 投票タイムアウト（秒）
  syncTimeout: number;          // 同期タイムアウト（秒）
  
  // セキュリティ設定
  maxReorgDepth: number;        // 最大再編成深度
  minShareDifficulty: number;   // 最小シェア難易度
  banThreshold: number;         // BANスコア閾値
}

export interface Share {
  id: string;
  minerId: string;
  hash: string;
  previousShareId: string;
  height: number;
  difficulty: number;
  timestamp: number;
  nonce: string;
  signature?: string;
  
  // P2Pool特有のフィールド
  uncles: string[];            // アンクルシェア
  totalDifficulty: number;     // 累積難易度
  minerAddress: string;        // 支払いアドレス
  donations?: number;          // 寄付率（％）
}

export interface ShareChainBlock {
  shares: Share[];
  height: number;
  hash: string;
  previousHash: string;
  timestamp: number;
  difficulty: number;
  
  // コンセンサス情報
  proposerId: string;
  votes: Vote[];
  finalized: boolean;
}

export interface Vote {
  voterId: string;
  shareHash: string;
  signature: string;
  timestamp: number;
  weight: number;              // 投票の重み（ハッシュレートベース）
}

export interface ConsensusState {
  currentHeight: number;
  latestShareHash: string;
  pendingShares: Share[];
  activeProposal?: Proposal;
  peerWeights: Map<string, number>;
  consensusReached: boolean;
}

export interface Proposal {
  id: string;
  proposerId: string;
  shares: Share[];
  height: number;
  timestamp: number;
  votes: Map<string, Vote>;
  status: 'pending' | 'accepted' | 'rejected' | 'timeout';
}

// === P2Pコンセンサスマネージャー ===
export class P2PConsensusManager extends EventEmitter {
  private config: ConsensusConfig;
  private shareChain: Map<number, ShareChainBlock> = new Map();
  private pendingShares: Map<string, Share> = new Map();
  private currentProposal?: Proposal;
  private peerWeights: Map<string, number> = new Map();
  private ourPeerId: string;
  private proposalTimer?: NodeJS.Timeout;
  private voteTimer?: NodeJS.Timeout;
  
  // パフォーマンスメトリクス
  private consensusMetrics = {
    proposalsCreated: 0,
    proposalsAccepted: 0,
    proposalsRejected: 0,
    averageConsensusTime: 0,
    reorgs: 0
  };
  
  constructor(config: ConsensusConfig, ourPeerId: string) {
    super();
    this.config = config;
    this.ourPeerId = ourPeerId;
  }
  
  // シェアの追加
  async addShare(share: Share): Promise<boolean> {
    try {
      // シェアの検証
      if (!await this.validateShare(share)) {
        return false;
      }
      
      // 重複チェック
      if (this.pendingShares.has(share.id)) {
        return false;
      }
      
      // ペンディングシェアに追加
      this.pendingShares.set(share.id, share);
      
      // 現在の提案に追加
      if (this.currentProposal && this.currentProposal.status === 'pending') {
        this.currentProposal.shares.push(share);
      }
      
      // 新しい提案の作成条件をチェック
      if (this.shouldCreateProposal()) {
        await this.createProposal();
      }
      
      this.emit('shareAdded', share);
      return true;
      
    } catch (error) {
      this.emit('error', { error, context: 'addShare' });
      return false;
    }
  }
  
  // 提案の受信
  async receiveProposal(proposal: Proposal, fromPeer: string): Promise<void> {
    try {
      // 提案の検証
      if (!await this.validateProposal(proposal)) {
        this.emit('invalidProposal', { proposal, fromPeer });
        return;
      }
      
      // 現在の提案と比較
      if (this.currentProposal && this.currentProposal.id !== proposal.id) {
        // より良い提案かチェック
        if (this.isBetterProposal(proposal, this.currentProposal)) {
          this.currentProposal = proposal;
          this.resetVoteTimer();
        }
      } else if (!this.currentProposal) {
        this.currentProposal = proposal;
        this.startVoteTimer();
      }
      
      // 自動投票
      await this.voteOnProposal(proposal);
      
      this.emit('proposalReceived', { proposal, fromPeer });
      
    } catch (error) {
      this.emit('error', { error, context: 'receiveProposal' });
    }
  }
  
  // 投票の受信
  async receiveVote(vote: Vote, fromPeer: string): Promise<void> {
    try {
      // 投票の検証
      if (!await this.validateVote(vote)) {
        this.emit('invalidVote', { vote, fromPeer });
        return;
      }
      
      // 現在の提案に対する投票かチェック
      if (!this.currentProposal || this.currentProposal.status !== 'pending') {
        return;
      }
      
      // 投票を記録
      this.currentProposal.votes.set(vote.voterId, vote);
      
      // コンセンサスチェック
      if (this.checkConsensus()) {
        await this.finalizeProposal();
      }
      
      this.emit('voteReceived', { vote, fromPeer });
      
    } catch (error) {
      this.emit('error', { error, context: 'receiveVote' });
    }
  }
  
  // 提案の作成
  private async createProposal(): Promise<void> {
    if (this.pendingShares.size === 0) {
      return;
    }
    
    const proposal: Proposal = {
      id: this.generateProposalId(),
      proposerId: this.ourPeerId,
      shares: Array.from(this.pendingShares.values()),
      height: this.getCurrentHeight() + 1,
      timestamp: Date.now(),
      votes: new Map(),
      status: 'pending'
    };
    
    // 自己投票
    const selfVote = await this.createVote(proposal);
    proposal.votes.set(this.ourPeerId, selfVote);
    
    this.currentProposal = proposal;
    this.consensusMetrics.proposalsCreated++;
    
    // タイマー開始
    this.startProposalTimer();
    
    // ブロードキャスト
    this.emit('proposalCreated', proposal);
  }
  
  // 提案への投票
  private async voteOnProposal(proposal: Proposal): Promise<void> {
    // 既に投票済みかチェック
    if (proposal.votes.has(this.ourPeerId)) {
      return;
    }
    
    // 提案の品質を評価
    const quality = await this.evaluateProposal(proposal);
    
    if (quality > 0.5) { // 閾値以上なら賛成票
      const vote = await this.createVote(proposal);
      proposal.votes.set(this.ourPeerId, vote);
      
      // ブロードキャスト
      this.emit('voteCast', vote);
    }
  }
  
  // コンセンサスチェック
  private checkConsensus(): boolean {
    if (!this.currentProposal || this.currentProposal.status !== 'pending') {
      return false;
    }
    
    // 総投票重みを計算
    let totalWeight = 0;
    let approvalWeight = 0;
    
    for (const [peerId, weight] of this.peerWeights) {
      totalWeight += weight;
      
      if (this.currentProposal.votes.has(peerId)) {
        approvalWeight += weight;
      }
    }
    
    // 自分の重みも追加
    const ourWeight = this.peerWeights.get(this.ourPeerId) || 1;
    totalWeight += ourWeight;
    if (this.currentProposal.votes.has(this.ourPeerId)) {
      approvalWeight += ourWeight;
    }
    
    // コンセンサス閾値チェック
    const approvalPercentage = (approvalWeight / totalWeight) * 100;
    return approvalPercentage >= this.config.consensusThreshold;
  }
  
  // 提案の確定
  private async finalizeProposal(): Promise<void> {
    if (!this.currentProposal || this.currentProposal.status !== 'pending') {
      return;
    }
    
    const startTime = this.currentProposal.timestamp;
    const consensusTime = Date.now() - startTime;
    
    // ブロックの作成
    const block: ShareChainBlock = {
      shares: this.currentProposal.shares,
      height: this.currentProposal.height,
      hash: this.calculateBlockHash(this.currentProposal),
      previousHash: this.getLatestBlockHash(),
      timestamp: Date.now(),
      difficulty: this.calculateBlockDifficulty(this.currentProposal.shares),
      proposerId: this.currentProposal.proposerId,
      votes: Array.from(this.currentProposal.votes.values()),
      finalized: true
    };
    
    // チェーンに追加
    this.shareChain.set(block.height, block);
    
    // ペンディングシェアをクリア
    for (const share of this.currentProposal.shares) {
      this.pendingShares.delete(share.id);
    }
    
    // メトリクス更新
    this.consensusMetrics.proposalsAccepted++;
    this.updateAverageConsensusTime(consensusTime);
    
    // 状態更新
    this.currentProposal.status = 'accepted';
    this.currentProposal = undefined;
    
    // タイマークリア
    this.clearTimers();
    
    this.emit('blockFinalized', block);
  }
  
  // シェアの検証
  private async validateShare(share: Share): Promise<boolean> {
    // 基本的な検証
    if (!share.id || !share.hash || !share.minerId) {
      return false;
    }
    
    // 難易度チェック
    if (share.difficulty < this.config.minShareDifficulty) {
      return false;
    }
    
    // タイムスタンプチェック
    const now = Date.now();
    const maxFuture = 60000; // 1分
    const maxPast = 3600000; // 1時間
    
    if (share.timestamp > now + maxFuture || share.timestamp < now - maxPast) {
      return false;
    }
    
    // 前のシェアとの連続性チェック
    if (share.height > 1) {
      const expectedHeight = this.getCurrentHeight() + 1;
      if (Math.abs(share.height - expectedHeight) > this.config.maxReorgDepth) {
        return false;
      }
    }
    
    // 署名検証（実装依存）
    if (share.signature) {
      // const isValid = await this.verifySignature(share);
      // if (!isValid) return false;
    }
    
    return true;
  }
  
  // 提案の検証
  private async validateProposal(proposal: Proposal): Promise<boolean> {
    // 基本検証
    if (!proposal.id || !proposal.proposerId || proposal.shares.length === 0) {
      return false;
    }
    
    // 高さの検証
    const expectedHeight = this.getCurrentHeight() + 1;
    if (proposal.height !== expectedHeight) {
      return false;
    }
    
    // 各シェアの検証
    for (const share of proposal.shares) {
      if (!await this.validateShare(share)) {
        return false;
      }
    }
    
    // タイムスタンプ検証
    const now = Date.now();
    if (proposal.timestamp > now + 60000 || proposal.timestamp < now - 300000) {
      return false;
    }
    
    return true;
  }
  
  // 投票の検証
  private async validateVote(vote: Vote): Promise<boolean> {
    // 基本検証
    if (!vote.voterId || !vote.shareHash || !vote.signature) {
      return false;
    }
    
    // タイムスタンプ検証
    const now = Date.now();
    if (vote.timestamp > now + 60000 || vote.timestamp < now - 300000) {
      return false;
    }
    
    // 署名検証（実装依存）
    // const isValid = await this.verifyVoteSignature(vote);
    // if (!isValid) return false;
    
    // 重みの検証
    if (vote.weight < 0) {
      return false;
    }
    
    return true;
  }
  
  // 提案の評価
  private async evaluateProposal(proposal: Proposal): Promise<number> {
    let score = 0;
    let totalWeight = 0;
    
    // シェアの品質評価
    for (const share of proposal.shares) {
      const shareScore = await this.evaluateShare(share);
      score += shareScore * share.difficulty;
      totalWeight += share.difficulty;
    }
    
    // 提案者の信頼度
    const proposerWeight = this.peerWeights.get(proposal.proposerId) || 0;
    const trustScore = Math.min(proposerWeight / 100, 1); // 正規化
    
    // 最終スコア（0-1）
    const finalScore = totalWeight > 0 ? (score / totalWeight) * 0.8 + trustScore * 0.2 : 0;
    
    return finalScore;
  }
  
  // シェアの評価
  private async evaluateShare(share: Share): Promise<number> {
    let score = 1.0;
    
    // タイムスタンプの妥当性
    const now = Date.now();
    const age = now - share.timestamp;
    if (age > 600000) { // 10分以上古い
      score *= 0.5;
    }
    
    // 難易度の妥当性
    const avgDifficulty = this.getAverageDifficulty();
    if (share.difficulty < avgDifficulty * 0.5) {
      score *= 0.7;
    }
    
    // マイナーの信頼度
    const minerWeight = this.peerWeights.get(share.minerId) || 0;
    score *= Math.min(minerWeight / 50 + 0.5, 1);
    
    return score;
  }
  
  // より良い提案かチェック
  private isBetterProposal(newProposal: Proposal, currentProposal: Proposal): boolean {
    // 総難易度で比較
    const newDifficulty = newProposal.shares.reduce((sum, s) => sum + s.difficulty, 0);
    const currentDifficulty = currentProposal.shares.reduce((sum, s) => sum + s.difficulty, 0);
    
    if (newDifficulty > currentDifficulty * 1.1) { // 10%以上高い
      return true;
    }
    
    // 投票数で比較
    if (newProposal.votes.size > currentProposal.votes.size * 1.5) {
      return true;
    }
    
    return false;
  }
  
  // チェーンの再編成
  async handleReorg(newChain: ShareChainBlock[], fromHeight: number): Promise<void> {
    try {
      // 新しいチェーンの検証
      if (!await this.validateChain(newChain)) {
        return;
      }
      
      // 現在のチェーンと比較
      const currentWork = this.calculateChainWork(fromHeight);
      const newWork = this.calculateChainWorkForBlocks(newChain);
      
      if (newWork <= currentWork) {
        return; // 新しいチェーンの方が仕事量が少ない
      }
      
      // 再編成の実行
      this.consensusMetrics.reorgs++;
      
      // 古いブロックを削除
      for (let height = fromHeight; height <= this.getCurrentHeight(); height++) {
        this.shareChain.delete(height);
      }
      
      // 新しいブロックを追加
      for (const block of newChain) {
        this.shareChain.set(block.height, block);
      }
      
      this.emit('reorg', { fromHeight, depth: newChain.length });
      
    } catch (error) {
      this.emit('error', { error, context: 'handleReorg' });
    }
  }
  
  // ピアの重み更新
  updatePeerWeight(peerId: string, hashrate: number): void {
    // ハッシュレートに基づいて重みを計算
    const weight = Math.log10(hashrate + 1) * 10; // 対数スケール
    this.peerWeights.set(peerId, weight);
    
    this.emit('peerWeightUpdated', { peerId, weight, hashrate });
  }
  
  // タイマー管理
  private startProposalTimer(): void {
    this.clearTimers();
    
    this.proposalTimer = setTimeout(() => {
      if (this.currentProposal && this.currentProposal.status === 'pending') {
        this.currentProposal.status = 'timeout';
        this.consensusMetrics.proposalsRejected++;
        this.currentProposal = undefined;
        this.emit('proposalTimeout');
      }
    }, this.config.proposalTimeout * 1000);
  }
  
  private startVoteTimer(): void {
    this.voteTimer = setTimeout(() => {
      if (this.currentProposal && this.currentProposal.status === 'pending') {
        // タイムアウトしてもコンセンサスチェック
        if (this.checkConsensus()) {
          this.finalizeProposal();
        } else {
          this.currentProposal.status = 'rejected';
          this.consensusMetrics.proposalsRejected++;
          this.currentProposal = undefined;
          this.emit('voteTimeout');
        }
      }
    }, this.config.voteTimeout * 1000);
  }
  
  private resetVoteTimer(): void {
    if (this.voteTimer) {
      clearTimeout(this.voteTimer);
    }
    this.startVoteTimer();
  }
  
  private clearTimers(): void {
    if (this.proposalTimer) {
      clearTimeout(this.proposalTimer);
      this.proposalTimer = undefined;
    }
    if (this.voteTimer) {
      clearTimeout(this.voteTimer);
      this.voteTimer = undefined;
    }
  }
  
  // ユーティリティメソッド
  private generateProposalId(): string {
    return `proposal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private async createVote(proposal: Proposal): Promise<Vote> {
    const vote: Vote = {
      voterId: this.ourPeerId,
      shareHash: this.calculateProposalHash(proposal),
      signature: 'mock_signature', // 実装依存
      timestamp: Date.now(),
      weight: this.peerWeights.get(this.ourPeerId) || 1
    };
    
    return vote;
  }
  
  private calculateBlockHash(proposal: Proposal): string {
    const data = JSON.stringify({
      shares: proposal.shares.map(s => s.id),
      height: proposal.height,
      proposerId: proposal.proposerId,
      timestamp: proposal.timestamp
    });
    
    return createHash('sha256').update(data).digest('hex');
  }
  
  private calculateProposalHash(proposal: Proposal): string {
    const data = JSON.stringify({
      id: proposal.id,
      shares: proposal.shares.map(s => s.id),
      height: proposal.height
    });
    
    return createHash('sha256').update(data).digest('hex');
  }
  
  private calculateBlockDifficulty(shares: Share[]): number {
    return shares.reduce((sum, share) => sum + share.difficulty, 0);
  }
  
  private getCurrentHeight(): number {
    let maxHeight = 0;
    for (const [height] of this.shareChain) {
      if (height > maxHeight) {
        maxHeight = height;
      }
    }
    return maxHeight;
  }
  
  private getLatestBlockHash(): string {
    const height = this.getCurrentHeight();
    const block = this.shareChain.get(height);
    return block?.hash || '0x0';
  }
  
  private getAverageDifficulty(): number {
    const recentBlocks = Array.from(this.shareChain.values()).slice(-10);
    if (recentBlocks.length === 0) return this.config.minShareDifficulty;
    
    const totalDifficulty = recentBlocks.reduce((sum, block) => sum + block.difficulty, 0);
    return totalDifficulty / recentBlocks.length;
  }
  
  private calculateChainWork(fromHeight: number): number {
    let work = 0;
    for (let height = fromHeight; height <= this.getCurrentHeight(); height++) {
      const block = this.shareChain.get(height);
      if (block) {
        work += block.difficulty;
      }
    }
    return work;
  }
  
  private calculateChainWorkForBlocks(blocks: ShareChainBlock[]): number {
    return blocks.reduce((sum, block) => sum + block.difficulty, 0);
  }
  
  private async validateChain(chain: ShareChainBlock[]): Promise<boolean> {
    // チェーンの連続性を検証
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].height !== chain[i-1].height + 1) {
        return false;
      }
      if (chain[i].previousHash !== chain[i-1].hash) {
        return false;
      }
    }
    
    // 各ブロックの検証
    for (const block of chain) {
      // ブロック内のシェアを検証
      for (const share of block.shares) {
        if (!await this.validateShare(share)) {
          return false;
        }
      }
    }
    
    return true;
  }
  
  private updateAverageConsensusTime(newTime: number): void {
    const total = this.consensusMetrics.proposalsAccepted + this.consensusMetrics.proposalsRejected;
    const oldAvg = this.consensusMetrics.averageConsensusTime;
    
    this.consensusMetrics.averageConsensusTime = (oldAvg * (total - 1) + newTime) / total;
  }
  
  // 公開API
  getConsensusState(): ConsensusState {
    return {
      currentHeight: this.getCurrentHeight(),
      latestShareHash: this.getLatestBlockHash(),
      pendingShares: Array.from(this.pendingShares.values()),
      activeProposal: this.currentProposal,
      peerWeights: new Map(this.peerWeights),
      consensusReached: this.currentProposal?.status === 'accepted' || false
    };
  }
  
  getMetrics(): typeof this.consensusMetrics {
    return { ...this.consensusMetrics };
  }
  
  getChainInfo(): any {
    return {
      height: this.getCurrentHeight(),
      difficulty: this.getAverageDifficulty(),
      blocks: this.shareChain.size,
      pendingShares: this.pendingShares.size,
      peers: this.peerWeights.size
    };
  }
  
  async syncWithPeer(peerId: string, fromHeight: number): Promise<ShareChainBlock[]> {
    // ピアとの同期（実装依存）
    const blocks: ShareChainBlock[] = [];
    
    for (let height = fromHeight; height <= this.getCurrentHeight(); height++) {
      const block = this.shareChain.get(height);
      if (block) {
        blocks.push(block);
      }
    }
    
    return blocks;
  }
  
  stop(): void {
    this.clearTimers();
    this.shareChain.clear();
    this.pendingShares.clear();
    this.peerWeights.clear();
    this.currentProposal = undefined;
  }
}

export default P2PConsensusManager;