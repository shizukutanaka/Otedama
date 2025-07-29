package zkp

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"math/big"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ZKPManager はゼロ知識証明システムのマネージャー
type ZKPManager struct {
	logger       *zap.Logger
	proofs       sync.Map
	verifiers    sync.Map
	trustedSetup *TrustedSetup
	mu           sync.RWMutex
}

// TrustedSetup は信頼できるセットアップパラメータ
type TrustedSetup struct {
	Generator *big.Int
	Prime     *big.Int
	Order     *big.Int
	CreatedAt time.Time
}

// Proof はゼロ知識証明
type Proof struct {
	ID          string    `json:"id"`
	ProverID    string    `json:"prover_id"`
	Statement   Statement `json:"statement"`
	Witness     []byte    `json:"witness,omitempty"` // 秘匿情報（検証時は含まない）
	Commitment  []byte    `json:"commitment"`
	Challenge   []byte    `json:"challenge"`
	Response    []byte    `json:"response"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	Verified    bool      `json:"verified"`
}

// Statement は証明したい文の記述
type Statement struct {
	Type       StatementType          `json:"type"`
	Parameters map[string]interface{} `json:"parameters"`
	MinValue   *big.Int               `json:"min_value,omitempty"`
	MaxValue   *big.Int               `json:"max_value,omitempty"`
	HashTarget []byte                 `json:"hash_target,omitempty"`
}

// StatementType は文の種類
type StatementType string

const (
	// Identity proof types
	StatementAgeProof      StatementType = "age_proof"      // 年齢証明（18歳以上など）
	StatementResidencyProof StatementType = "residency_proof" // 居住地証明
	StatementIncomeProof   StatementType = "income_proof"   // 収入証明
	
	// Mining-specific proof types  
	StatementHashPowerProof StatementType = "hashpower_proof" // ハッシュパワー証明
	StatementStakeProof    StatementType = "stake_proof"    // ステーク証明
	StatementReputationProof StatementType = "reputation_proof" // 評判証明
	
	// Compliance proof types
	StatementSanctionProof StatementType = "sanction_proof" // 制裁リスト非該当証明
	StatementKYCProof      StatementType = "kyc_proof"      // KYC準拠証明
)

// VerificationResult は検証結果
type VerificationResult struct {
	Valid       bool      `json:"valid"`
	ProofID     string    `json:"proof_id"`
	ProverID    string    `json:"prover_id"`
	Statement   Statement `json:"statement"`
	VerifiedAt  time.Time `json:"verified_at"`
	VerifierID  string    `json:"verifier_id"`
	Score       float64   `json:"score"`       // 信頼度スコア (0-1)
	Reputation  float64   `json:"reputation"`  // 評判スコア (0-1)
}

// NewZKPManager は新しいZKPマネージャーを作成
func NewZKPManager(logger *zap.Logger) *ZKPManager {
	manager := &ZKPManager{
		logger: logger,
		trustedSetup: generateTrustedSetup(),
	}
	
	// 定期的なプルーフクリーンアップ
	go manager.cleanupExpiredProofs()
	
	return manager
}

// generateTrustedSetup は信頼できるセットアップを生成
func generateTrustedSetup() *TrustedSetup {
	// 実用的な楕円曲線パラメータを使用（簡略化版）
	prime, _ := new(big.Int).SetString("115792089237316195423570985008687907853269984665640564039457584007913129639747", 10)
	order, _ := new(big.Int).SetString("115792089237316195423570985008687907852837564279074904382605163141518161494337", 10)
	generator := big.NewInt(3)
	
	return &TrustedSetup{
		Generator: generator,
		Prime:     prime,
		Order:     order,
		CreatedAt: time.Now(),
	}
}

// GenerateProof はゼロ知識証明を生成
func (zkp *ZKPManager) GenerateProof(proverID string, statement Statement, witness []byte) (*Proof, error) {
	zkp.logger.Info("Generating ZK proof", 
		zap.String("prover_id", proverID),
		zap.String("statement_type", string(statement.Type)))
	
	// プルーフIDを生成
	proofID := zkp.generateProofID(proverID, statement)
	
	// コミットフェーズ
	commitment, randomness, err := zkp.generateCommitment(statement, witness)
	if err != nil {
		return nil, fmt.Errorf("failed to generate commitment: %w", err)
	}
	
	// チャレンジフェーズ
	challenge := zkp.generateChallenge(commitment, statement)
	
	// レスポンスフェーズ
	response, err := zkp.generateResponse(challenge, witness, randomness, statement)
	if err != nil {
		return nil, fmt.Errorf("failed to generate response: %w", err)
	}
	
	proof := &Proof{
		ID:         proofID,
		ProverID:   proverID,
		Statement:  statement,
		Witness:    witness, // 本来は秘匿すべき
		Commitment: commitment,
		Challenge:  challenge,
		Response:   response,
		CreatedAt:  time.Now(),
		ExpiresAt:  time.Now().Add(24 * time.Hour), // 24時間有効
		Verified:   false,
	}
	
	// プルーフを保存
	zkp.proofs.Store(proofID, proof)
	
	zkp.logger.Info("ZK proof generated successfully", zap.String("proof_id", proofID))
	
	return proof, nil
}

// VerifyProof はゼロ知識証明を検証
func (zkp *ZKPManager) VerifyProof(proofID string, verifierID string) (*VerificationResult, error) {
	zkp.logger.Info("Verifying ZK proof", 
		zap.String("proof_id", proofID),
		zap.String("verifier_id", verifierID))
	
	// プルーフを取得
	proofInterface, exists := zkp.proofs.Load(proofID)
	if !exists {
		return nil, fmt.Errorf("proof not found: %s", proofID)
	}
	
	proof := proofInterface.(*Proof)
	
	// 有効期限チェック
	if time.Now().After(proof.ExpiresAt) {
		return &VerificationResult{
			Valid:      false,
			ProofID:    proofID,
			ProverID:   proof.ProverID,
			Statement:  proof.Statement,
			VerifiedAt: time.Now(),
			VerifierID: verifierID,
		}, fmt.Errorf("proof expired")
	}
	
	// ゼロ知識証明の検証
	valid, err := zkp.verifyProofInternal(proof)
	if err != nil {
		return nil, fmt.Errorf("verification failed: %w", err)
	}
	
	// 信頼度スコアとレピュテーションを計算
	score := zkp.calculateTrustScore(proof, verifierID)
	reputation := zkp.calculateReputation(proof.ProverID)
	
	result := &VerificationResult{
		Valid:      valid,
		ProofID:    proofID,
		ProverID:   proof.ProverID,
		Statement:  proof.Statement,
		VerifiedAt: time.Now(),
		VerifierID: verifierID,
		Score:      score,
		Reputation: reputation,
	}
	
	if valid {
		proof.Verified = true
		zkp.proofs.Store(proofID, proof)
		zkp.logger.Info("ZK proof verification successful", zap.String("proof_id", proofID))
	} else {
		zkp.logger.Warn("ZK proof verification failed", zap.String("proof_id", proofID))
	}
	
	return result, nil
}

// generateProofID はプルーフIDを生成
func (zkp *ZKPManager) generateProofID(proverID string, statement Statement) string {
	hash := sha256.New()
	hash.Write([]byte(proverID))
	hash.Write([]byte(string(statement.Type)))
	hash.Write([]byte(fmt.Sprintf("%d", time.Now().UnixNano())))
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

// generateCommitment はコミットメントを生成
func (zkp *ZKPManager) generateCommitment(statement Statement, witness []byte) ([]byte, []byte, error) {
	// ランダムネスを生成
	randomness := make([]byte, 32)
	if _, err := rand.Read(randomness); err != nil {
		return nil, nil, err
	}
	
	// コミットメント = Hash(witness || randomness)
	hash := sha256.New()
	hash.Write(witness)
	hash.Write(randomness)
	commitment := hash.Sum(nil)
	
	return commitment, randomness, nil
}

// generateChallenge はチャレンジを生成
func (zkp *ZKPManager) generateChallenge(commitment []byte, statement Statement) []byte {
	hash := sha256.New()
	hash.Write(commitment)
	hash.Write([]byte(string(statement.Type)))
	if statement.HashTarget != nil {
		hash.Write(statement.HashTarget)
	}
	return hash.Sum(nil)
}

// generateResponse はレスポンスを生成
func (zkp *ZKPManager) generateResponse(challenge, witness, randomness []byte, statement Statement) ([]byte, error) {
	// 簡略化されたレスポンス生成
	hash := sha256.New()
	hash.Write(challenge)
	hash.Write(witness)
	hash.Write(randomness)
	
	switch statement.Type {
	case StatementAgeProof:
		// 年齢証明のレスポンス
		return zkp.generateAgeProofResponse(hash, statement)
	case StatementHashPowerProof:
		// ハッシュパワー証明のレスポンス
		return zkp.generateHashPowerResponse(hash, statement)
	default:
		return hash.Sum(nil), nil
	}
}

// generateAgeProofResponse は年齢証明のレスポンスを生成
func (zkp *ZKPManager) generateAgeProofResponse(hasher hash.Hash, statement Statement) ([]byte, error) {
	// 年齢証明固有のロジック
	minAge, ok := statement.Parameters["min_age"].(float64)
	if !ok {
		minAge = 18 // デフォルト
	}
	
	hasher.Write([]byte(fmt.Sprintf("age_threshold_%.0f", minAge)))
	return hasher.Sum(nil), nil
}

// generateHashPowerResponse はハッシュパワー証明のレスポンスを生成
func (zkp *ZKPManager) generateHashPowerResponse(hasher hash.Hash, statement Statement) ([]byte, error) {
	// ハッシュパワー証明固有のロジック
	minHashPower, ok := statement.Parameters["min_hashpower"].(float64)
	if !ok {
		minHashPower = 1000 // デフォルト（H/s）
	}
	
	hasher.Write([]byte(fmt.Sprintf("hashpower_threshold_%.0f", minHashPower)))
	return hasher.Sum(nil), nil
}

// verifyProofInternal は内部的な証明検証
func (zkp *ZKPManager) verifyProofInternal(proof *Proof) (bool, error) {
	// 1. チャレンジの再生成と確認
	expectedChallenge := zkp.generateChallenge(proof.Commitment, proof.Statement)
	if !zkp.bytesEqual(expectedChallenge, proof.Challenge) {
		return false, fmt.Errorf("challenge mismatch")
	}
	
	// 2. レスポンスの検証（簡略化）
	switch proof.Statement.Type {
	case StatementAgeProof:
		return zkp.verifyAgeProof(proof)
	case StatementHashPowerProof:
		return zkp.verifyHashPowerProof(proof)
	case StatementKYCProof:
		return zkp.verifyKYCProof(proof)
	default:
		return zkp.verifyGenericProof(proof)
	}
}

// verifyAgeProof は年齢証明を検証
func (zkp *ZKPManager) verifyAgeProof(proof *Proof) (bool, error) {
	// 年齢証明の検証ロジック
	// 実際の実装では、より複雑な暗号学的検証が必要
	
	minAge, ok := proof.Statement.Parameters["min_age"].(float64)
	if !ok {
		minAge = 18
	}
	
	// 簡略化された検証：レスポンスのハッシュが期待値と一致するかチェック
	hash := sha256.New()
	hash.Write(proof.Challenge)
	hash.Write([]byte(fmt.Sprintf("age_threshold_%.0f", minAge)))
	
	expectedResponse := hash.Sum(nil)
	return zkp.bytesEqual(expectedResponse, proof.Response), nil
}

// verifyHashPowerProof はハッシュパワー証明を検証
func (zkp *ZKPManager) verifyHashPowerProof(proof *Proof) (bool, error) {
	// ハッシュパワー証明の検証
	minHashPower, ok := proof.Statement.Parameters["min_hashpower"].(float64)
	if !ok {
		minHashPower = 1000
	}
	
	hash := sha256.New()
	hash.Write(proof.Challenge)
	hash.Write([]byte(fmt.Sprintf("hashpower_threshold_%.0f", minHashPower)))
	
	expectedResponse := hash.Sum(nil)
	return zkp.bytesEqual(expectedResponse, proof.Response), nil
}

// verifyKYCProof はKYC証明を検証
func (zkp *ZKPManager) verifyKYCProof(proof *Proof) (bool, error) {
	// KYC証明の検証
	// 制裁リスト、PEPリストなどのチェック
	
	// 簡略化された実装
	hash := sha256.New()
	hash.Write(proof.Challenge)
	hash.Write([]byte("kyc_compliant"))
	
	expectedResponse := hash.Sum(nil)
	return zkp.bytesEqual(expectedResponse, proof.Response), nil
}

// verifyGenericProof は汎用証明を検証
func (zkp *ZKPManager) verifyGenericProof(proof *Proof) (bool, error) {
	// 汎用的な証明検証
	hash := sha256.New()
	hash.Write(proof.Challenge)
	
	expectedResponse := hash.Sum(nil)
	return zkp.bytesEqual(expectedResponse, proof.Response), nil
}

// calculateTrustScore は信頼度スコアを計算
func (zkp *ZKPManager) calculateTrustScore(proof *Proof, verifierID string) float64 {
	baseScore := 0.5 // ベーススコア
	
	// プルーフタイプに応じたスコア調整
	switch proof.Statement.Type {
	case StatementKYCProof:
		baseScore += 0.3
	case StatementAgeProof:
		baseScore += 0.2
	case StatementHashPowerProof:
		baseScore += 0.1
	}
	
	// 検証者の信頼度による調整
	verifierTrust := zkp.getVerifierTrust(verifierID)
	baseScore += verifierTrust * 0.2
	
	// スコアを0-1の範囲に正規化
	if baseScore > 1.0 {
		baseScore = 1.0
	}
	if baseScore < 0.0 {
		baseScore = 0.0
	}
	
	return baseScore
}

// calculateReputation はレピュテーションを計算
func (zkp *ZKPManager) calculateReputation(proverID string) float64 {
	// プルーバーの過去の検証履歴から計算
	reputation := 0.5 // デフォルト値
	
	// 簡略化された実装
	// 実際の実装では、過去の検証成功率、頻度、多様性などを考慮
	
	return reputation
}

// getVerifierTrust は検証者の信頼度を取得
func (zkp *ZKPManager) getVerifierTrust(verifierID string) float64 {
	// 検証者の信頼度を取得（簡略化）
	return 0.8 // デフォルト値
}

// bytesEqual はバイト配列の比較
func (zkp *ZKPManager) bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// cleanupExpiredProofs は期限切れプルーフをクリーンアップ
func (zkp *ZKPManager) cleanupExpiredProofs() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for range ticker.C {
		now := time.Now()
		expiredCount := 0
		
		zkp.proofs.Range(func(key, value interface{}) bool {
			proof := value.(*Proof)
			if now.After(proof.ExpiresAt) {
				zkp.proofs.Delete(key)
				expiredCount++
			}
			return true
		})
		
		if expiredCount > 0 {
			zkp.logger.Info("Cleaned up expired proofs", zap.Int("count", expiredCount))
		}
	}
}

// GetProofStats はプルーフ統計を取得
func (zkp *ZKPManager) GetProofStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_proofs":    0,
		"verified_proofs": 0,
		"expired_proofs":  0,
		"proof_types":     make(map[string]int),
	}
	
	now := time.Now()
	zkp.proofs.Range(func(key, value interface{}) bool {
		proof := value.(*Proof)
		stats["total_proofs"] = stats["total_proofs"].(int) + 1
		
		if proof.Verified {
			stats["verified_proofs"] = stats["verified_proofs"].(int) + 1
		}
		
		if now.After(proof.ExpiresAt) {
			stats["expired_proofs"] = stats["expired_proofs"].(int) + 1
		}
		
		proofTypes := stats["proof_types"].(map[string]int)
		proofTypes[string(proof.Statement.Type)]++
		
		return true
	})
	
	return stats
}

// CreateKYCProof はKYC証明を作成
func (zkp *ZKPManager) CreateKYCProof(userID string, kycData map[string]interface{}) (*Proof, error) {
	statement := Statement{
		Type: StatementKYCProof,
		Parameters: map[string]interface{}{
			"sanctions_clear": true,
			"pep_clear":      true,
			"verified":       true,
		},
	}
	
	// KYCデータをwitnessとして使用（実際の実装では暗号化が必要）
	witnessData := make([]byte, 0)
	for key, value := range kycData {
		witnessData = append(witnessData, []byte(fmt.Sprintf("%s:%v", key, value))...)
	}
	
	return zkp.GenerateProof(userID, statement, witnessData)
}