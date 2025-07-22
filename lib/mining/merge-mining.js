const { EventEmitter } = require('events');
const crypto = require('crypto');

/**
 * マージマイニング実装
 * 複数のブロックチェーンを同時にマイニング
 */
class MergeMining extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            enabled: config.enabled !== false,
            maxAuxChains: config.maxAuxChains || 5,
            mmTag: config.mmTag || Buffer.from('fabe6d6d', 'hex'), // Merge Mining Tag
            ...config
        };
        
        this.parentChain = null;
        this.auxChains = new Map();
        this.currentJobs = new Map();
        this.auxPowCache = new Map();
    }
    
    /**
     * 親チェーンを設定
     */
    setParentChain(chain) {
        this.parentChain = {
            name: chain.name,
            symbol: chain.symbol,
            rpcClient: chain.rpcClient,
            difficulty: chain.difficulty,
            height: chain.height
        };
        
        this.emit('parent-chain-set', this.parentChain);
    }
    
    /**
     * 補助チェーンを追加
     */
    addAuxiliaryChain(chain) {
        if (this.auxChains.size >= this.config.maxAuxChains) {
            throw new Error('Maximum auxiliary chains reached');
        }
        
        const chainId = this.generateChainId(chain.name);
        
        this.auxChains.set(chainId, {
            id: chainId,
            name: chain.name,
            symbol: chain.symbol,
            rpcClient: chain.rpcClient,
            chainIndex: this.auxChains.size,
            merkleIndex: this.calculateMerkleIndex(this.auxChains.size),
            enabled: true,
            stats: {
                blocksFound: 0,
                lastBlock: null,
                difficulty: 0
            }
        });
        
        this.emit('aux-chain-added', { chainId, name: chain.name });
    }
    
    /**
     * マージマイニングジョブを準備
     */
    async prepareMergedJob(parentTemplate) {
        if (!this.config.enabled || this.auxChains.size === 0) {
            return parentTemplate;
        }
        
        try {
            // 各補助チェーンのブロックテンプレートを取得
            const auxTemplates = await this.getAuxTemplates();
            
            // 補助ブロックハッシュのマークルルートを計算
            const auxMerkleRoot = this.calculateAuxMerkleRoot(auxTemplates);
            
            // マージマイニングコミットメントを作成
            const mmCommitment = this.createMMCommitment(auxMerkleRoot, parentTemplate.height);
            
            // 親チェーンのコインベーストランザクションに埋め込む
            const modifiedTemplate = this.embedCommitment(parentTemplate, mmCommitment);
            
            // ジョブを保存
            const jobId = this.generateJobId();
            this.currentJobs.set(jobId, {
                parentTemplate: modifiedTemplate,
                auxTemplates,
                auxMerkleRoot,
                created: Date.now()
            });
            
            this.emit('merged-job-created', {
                jobId,
                parentHeight: parentTemplate.height,
                auxChains: auxTemplates.length
            });
            
            return {
                ...modifiedTemplate,
                mergedMining: true,
                mergedJobId: jobId
            };
            
        } catch (error) {
            this.emit('merge-mining-error', error);
            // エラー時は通常のテンプレートを返す
            return parentTemplate;
        }
    }
    
    /**
     * 補助チェーンのテンプレートを取得
     */
    async getAuxTemplates() {
        const templates = [];
        
        for (const [chainId, chain] of this.auxChains) {
            if (!chain.enabled) continue;
            
            try {
                const template = await chain.rpcClient.getBlockTemplate();
                
                templates.push({
                    chainId,
                    chainIndex: chain.chainIndex,
                    template,
                    blockHash: this.calculateBlockHash(template),
                    target: template.target
                });
                
            } catch (error) {
                this.emit('aux-template-error', { chainId, error });
            }
        }
        
        return templates;
    }
    
    /**
     * 補助ブロックハッシュのマークルルートを計算
     */
    calculateAuxMerkleRoot(auxTemplates) {
        if (auxTemplates.length === 0) {
            return Buffer.alloc(32);
        }
        
        // 補助チェーンのブロックハッシュを収集
        const hashes = new Array(Math.pow(2, Math.ceil(Math.log2(this.config.maxAuxChains)))).fill(null);
        
        auxTemplates.forEach(aux => {
            hashes[aux.chainIndex] = aux.blockHash;
        });
        
        // nullをゼロハッシュで埋める
        for (let i = 0; i < hashes.length; i++) {
            if (hashes[i] === null) {
                hashes[i] = Buffer.alloc(32);
            }
        }
        
        // マークルツリーを構築
        return this.buildMerkleRoot(hashes);
    }
    
    /**
     * マージマイニングコミットメントを作成
     */
    createMMCommitment(auxMerkleRoot, parentHeight) {
        // フォーマット: MM_TAG + MERKLE_ROOT + BLOCK_SIZE + NONCE
        const commitment = Buffer.concat([
            this.config.mmTag,                    // 4 bytes
            auxMerkleRoot,                        // 32 bytes
            Buffer.from([0x01, 0x00, 0x00, 0x00]), // 4 bytes (aux chain count)
            Buffer.from([0x00, 0x00, 0x00, 0x00])  // 4 bytes (nonce)
        ]);
        
        return commitment;
    }
    
    /**
     * コインベーストランザクションにコミットメントを埋め込む
     */
    embedCommitment(template, commitment) {
        const modifiedTemplate = { ...template };
        
        // コインベーストランザクションのスクリプトシグに追加
        if (!modifiedTemplate.coinbasetxn) {
            // コインベーストランザクションを作成
            modifiedTemplate.coinbasetxn = this.createCoinbaseTx(template);
        }
        
        // OP_RETURNアウトプットとしてコミットメントを追加
        const commitmentOutput = {
            value: 0,
            scriptPubKey: Buffer.concat([
                Buffer.from([0x6a]), // OP_RETURN
                Buffer.from([commitment.length]),
                commitment
            ])
        };
        
        // コインベーストランザクションに追加
        // 実際の実装はトランザクション形式に依存
        
        return modifiedTemplate;
    }
    
    /**
     * マイニング結果を処理
     */
    async processSolution(jobId, solution) {
        const job = this.currentJobs.get(jobId);
        if (!job) {
            throw new Error('Job not found');
        }
        
        const results = {
            parent: false,
            auxiliary: []
        };
        
        // 親チェーンの検証
        const parentHash = this.calculateHash(job.parentTemplate, solution);
        if (this.meetsTarget(parentHash, job.parentTemplate.target)) {
            results.parent = true;
            
            // 親チェーンにブロックを送信
            try {
                await this.submitParentBlock(job.parentTemplate, solution);
                this.emit('parent-block-found', {
                    height: job.parentTemplate.height,
                    hash: parentHash.toString('hex')
                });
            } catch (error) {
                this.emit('parent-submit-error', error);
            }
        }
        
        // 補助チェーンの検証
        for (const aux of job.auxTemplates) {
            if (this.meetsTarget(parentHash, aux.target)) {
                results.auxiliary.push(aux.chainId);
                
                // 補助プルーフを作成
                const auxPow = this.createAuxPow(job, aux, solution, parentHash);
                
                // 補助チェーンにブロックを送信
                try {
                    await this.submitAuxBlock(aux.chainId, auxPow);
                    
                    const chain = this.auxChains.get(aux.chainId);
                    chain.stats.blocksFound++;
                    chain.stats.lastBlock = Date.now();
                    
                    this.emit('aux-block-found', {
                        chainId: aux.chainId,
                        chainName: chain.name,
                        hash: parentHash.toString('hex')
                    });
                    
                } catch (error) {
                    this.emit('aux-submit-error', { chainId: aux.chainId, error });
                }
            }
        }
        
        return results;
    }
    
    /**
     * 補助プルーフ（AuxPoW）を作成
     */
    createAuxPow(job, auxTemplate, solution, parentHash) {
        // マークルブランチを計算
        const merkleSize = Math.pow(2, Math.ceil(Math.log2(this.config.maxAuxChains)));
        const merkleBranch = this.getMerkleBranch(auxTemplate.chainIndex, merkleSize);
        
        const auxPow = {
            // 親ブロックヘッダー
            parentBlock: {
                header: job.parentTemplate.header,
                solution: solution,
                hash: parentHash
            },
            
            // コインベーストランザクション
            coinbaseTx: job.parentTemplate.coinbasetxn,
            
            // 親ブロックのマークルブランチ
            parentMerkleBranch: job.parentTemplate.merkleBranch || [],
            
            // 補助チェーンのマークルブランチ
            auxMerkleBranch: merkleBranch,
            auxMerkleIndex: auxTemplate.chainIndex,
            
            // 親チェーン情報
            parentChainId: this.parentChain.symbol
        };
        
        return auxPow;
    }
    
    /**
     * マークルブランチを取得
     */
    getMerkleBranch(index, size) {
        const branch = [];
        let k = index;
        
        for (let i = 0; i < Math.log2(size); i++) {
            const sibling = k ^ 1;
            branch.push(sibling);
            k = Math.floor(k / 2);
        }
        
        return branch;
    }
    
    /**
     * ブロックハッシュを計算
     */
    calculateBlockHash(template) {
        // 実際の実装はブロックチェーンによって異なる
        const header = Buffer.concat([
            Buffer.from(template.version, 'hex'),
            Buffer.from(template.previousblockhash, 'hex'),
            Buffer.from(template.merkleroot || '', 'hex'),
            Buffer.from(template.curtime.toString(16).padStart(8, '0'), 'hex'),
            Buffer.from(template.bits, 'hex')
        ]);
        
        return crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(header).digest()
        ).digest();
    }
    
    /**
     * マークルルートを構築
     */
    buildMerkleRoot(hashes) {
        if (hashes.length === 1) {
            return hashes[0];
        }
        
        const nextLevel = [];
        
        for (let i = 0; i < hashes.length; i += 2) {
            const left = hashes[i];
            const right = hashes[i + 1] || hashes[i];
            
            const combined = Buffer.concat([left, right]);
            const hash = crypto.createHash('sha256').update(
                crypto.createHash('sha256').update(combined).digest()
            ).digest();
            
            nextLevel.push(hash);
        }
        
        return this.buildMerkleRoot(nextLevel);
    }
    
    /**
     * ターゲットを満たすかチェック
     */
    meetsTarget(hash, target) {
        const targetBuf = Buffer.from(target, 'hex');
        return hash.compare(targetBuf) <= 0;
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const stats = {
            enabled: this.config.enabled,
            parentChain: this.parentChain ? this.parentChain.name : null,
            auxiliaryChains: []
        };
        
        this.auxChains.forEach((chain, chainId) => {
            stats.auxiliaryChains.push({
                id: chainId,
                name: chain.name,
                symbol: chain.symbol,
                enabled: chain.enabled,
                blocksFound: chain.stats.blocksFound,
                lastBlock: chain.stats.lastBlock,
                difficulty: chain.stats.difficulty
            });
        });
        
        return stats;
    }
    
    /**
     * 補助チェーンを有効/無効化
     */
    toggleAuxChain(chainId, enabled) {
        const chain = this.auxChains.get(chainId);
        if (chain) {
            chain.enabled = enabled;
            this.emit('aux-chain-toggled', { chainId, enabled });
        }
    }
    
    /**
     * ヘルパー関数
     */
    
    generateChainId(name) {
        return crypto.createHash('sha256')
            .update(name)
            .digest('hex')
            .substring(0, 8);
    }
    
    generateJobId() {
        return `mm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    calculateMerkleIndex(chainIndex) {
        // チェーンインデックスからマークルツリー内の位置を計算
        return chainIndex;
    }
    
    calculateHash(template, solution) {
        // 実際のハッシュ計算（アルゴリズム依存）
        return crypto.randomBytes(32);
    }
    
    async submitParentBlock(template, solution) {
        // 親チェーンへのブロック送信
        return true;
    }
    
    async submitAuxBlock(chainId, auxPow) {
        // 補助チェーンへのブロック送信
        const chain = this.auxChains.get(chainId);
        if (chain && chain.rpcClient) {
            // return await chain.rpcClient.submitAuxBlock(auxPow);
        }
        return true;
    }
}

module.exports = MergeMining;