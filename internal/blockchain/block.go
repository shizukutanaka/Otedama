package blockchain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/otedama/otedama/internal/dex"
)

type BlockHeader struct {
	Version       uint32
	PrevHash      string
	MerkleRoot    string
	Timestamp     int64
	Bits          uint32
	Nonce         uint32
	Height        uint64
	TxCount       uint32
}

type Transaction struct {
	TxHash    string
	From      string
	To        string
	Value     uint64
	Data      []byte
	Nonce     uint64
	GasPrice  uint64
	GasLimit  uint64
	Signature []byte
	Timestamp int64
}

type Block struct {
	Header       BlockHeader
	Transactions []Transaction
	Hash         string
}

func NewBlock(prevHash string, height uint64) *Block {
	return &Block{
		Header: BlockHeader{
			Version:   1,
			PrevHash:  prevHash,
			Timestamp: time.Now().Unix(),
			Height:    height,
		},
		Transactions: make([]Transaction, 0),
	}
}

func (b *Block) AddTransaction(tx Transaction) {
	b.Transactions = append(b.Transactions, tx)
	b.Header.TxCount++
}

// DexTx and LendingTx fields removed from Block struct
// AddDexTransaction and AddLendingTransaction methods removed

func (b *Block) CalculateMerkleRoot() string {
	var txHashes []string

	for _, tx := range b.Transactions {
		txHashes = append(txHashes, tx.TxHash)
	}

	if len(txHashes) == 0 {
		return ""
	}

	return calculateMerkleRoot(txHashes)
}

func calculateMerkleRoot(hashes []string) string {
	if len(hashes) == 0 {
		return ""
	}

	if len(hashes) == 1 {
		return hashes[0]
	}

	var newLevel []string

	for i := 0; i < len(hashes); i += 2 {
		var combined string
		if i+1 < len(hashes) {
			combined = hashes[i] + hashes[i+1]
		} else {
			combined = hashes[i] + hashes[i]
		}
		
		hash := sha256.Sum256([]byte(combined))
		newLevel = append(newLevel, hex.EncodeToString(hash[:]))
	}

	return calculateMerkleRoot(newLevel)
}

func (b *Block) CalculateHash() string {
	b.Header.MerkleRoot = b.CalculateMerkleRoot()
	
	data := fmt.Sprintf("%d%s%s%d%d%d%d%d",
		b.Header.Version,
		b.Header.PrevHash,
		b.Header.MerkleRoot,
		b.Header.Timestamp,
		b.Header.Bits,
		b.Header.Nonce,
		b.Header.Height,
		b.Header.TxCount,
	)

	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

func (b *Block) Mine(difficulty uint32) {
	target := calculateTarget(difficulty)
	
	for {
		b.Hash = b.CalculateHash()
		
		if isValidHash(b.Hash, target) {
			break
		}
		
		b.Header.Nonce++
		
		if b.Header.Nonce == 0 {
			b.Header.Timestamp = time.Now().Unix()
		}
	}
}

func calculateTarget(difficulty uint32) string {
	target := ""
	for i := uint32(0); i < difficulty; i++ {
		target += "0"
	}
	return target
}

func isValidHash(hash string, target string) bool {
	return hash[:len(target)] == target
}

type Blockchain struct {
	blocks    []*Block
	mempool   *Mempool
	stateDB   *StateDB
}

type Mempool struct {
	transactions []Transaction
	dexTx        []dex.TokenPair
	lendingTx    []string
}

func NewBlockchain() *Blockchain {
	genesis := NewBlock("", 0)
	genesis.Mine(4)
	
	return &Blockchain{
		blocks: []*Block{genesis},
		mempool: &Mempool{
			transactions: make([]Transaction, 0),
			dexTx:        make([]dex.TokenPair, 0),
			lendingTx:    make([]string, 0),
		},
		stateDB: NewStateDB(),
	}
}

func (bc *Blockchain) AddBlock(block *Block) error {
	if len(bc.blocks) == 0 {
		return fmt.Errorf("blockchain not initialized")
	}

	lastBlock := bc.blocks[len(bc.blocks)-1]
	
	if block.Header.PrevHash != lastBlock.Hash {
		return fmt.Errorf("invalid previous hash")
	}

	if block.Header.Height != lastBlock.Header.Height+1 {
		return fmt.Errorf("invalid block height")
	}

	bc.blocks = append(bc.blocks, block)
	
	if err := bc.stateDB.ApplyBlock(block); err != nil {
		bc.blocks = bc.blocks[:len(bc.blocks)-1]
		return fmt.Errorf("failed to apply block to state: %v", err)
	}

	return nil
}

func (bc *Blockchain) GetLatestBlock() *Block {
	if len(bc.blocks) == 0 {
		return nil
	}
	return bc.blocks[len(bc.blocks)-1]
}

func (bc *Blockchain) GetBlockByHeight(height uint64) *Block {
	for _, block := range bc.blocks {
		if block.Header.Height == height {
			return block
		}
	}
	return nil
}

func (bc *Blockchain) GetBlockByHash(hash string) *Block {
	for _, block := range bc.blocks {
		if block.Hash == hash {
			return block
		}
	}
	return nil
}

func (bc *Blockchain) AddTransactionToMempool(tx Transaction) {
	bc.mempool.transactions = append(bc.mempool.transactions, tx)
}

func (bc *Blockchain) AddDexTransactionToMempool(tx dex.TokenPair) {
	bc.mempool.dexTx = append(bc.mempool.dexTx, tx)
}

func (bc *Blockchain) AddLendingTransactionToMempool(tx string) {
	bc.mempool.lendingTx = append(bc.mempool.lendingTx, tx)
}

func (bc *Blockchain) CreateNewBlock() *Block {
	lastBlock := bc.GetLatestBlock()
	newBlock := NewBlock(lastBlock.Hash, lastBlock.Header.Height+1)

	for _, tx := range bc.mempool.transactions {
		newBlock.AddTransaction(tx)
	}

	// DexTx and LendingTx processing removed

	bc.mempool.transactions = make([]Transaction, 0)
	bc.mempool.dexTx = make([]dex.TokenPair, 0)
	bc.mempool.lendingTx = make([]string, 0)

	return newBlock
}