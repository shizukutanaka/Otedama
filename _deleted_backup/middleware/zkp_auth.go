package middleware

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/zkp"
	"go.uber.org/zap"
)

// ZKPAuthMiddleware はゼロ知識証明による認証ミドルウェア
type ZKPAuthMiddleware struct {
	zkpManager *zkp.ZKPManager
	config     *config.ZKPConfig
	logger     *zap.Logger
}

// NewZKPAuthMiddleware は新しいZKP認証ミドルウェアを作成
func NewZKPAuthMiddleware(zkpManager *zkp.ZKPManager, config *config.ZKPConfig, logger *zap.Logger) *ZKPAuthMiddleware {
	return &ZKPAuthMiddleware{
		zkpManager: zkpManager,
		config:     config,
		logger:     logger,
	}
}

// VerifyConnection はP2P接続時のZKP検証
func (m *ZKPAuthMiddleware) VerifyConnection(peerID string, proof *zkp.Proof) error {
	if !m.config.Enabled {
		return nil
	}

	// 年齢証明が必要な場合
	if m.config.RequireAgeProof {
		if proof.Statement.Type != zkp.StatementAgeProof {
			return fmt.Errorf("age proof required")
		}

		minAge, ok := proof.Statement.Parameters["min_age"].(float64)
		if !ok || int(minAge) < m.config.MinAgeRequirement {
			return fmt.Errorf("minimum age requirement not met: %d", m.config.MinAgeRequirement)
		}
	}

	// ハッシュパワー証明が必要な場合
	if m.config.RequireHashpowerProof {
		if proof.Statement.Type != zkp.StatementHashPowerProof {
			return fmt.Errorf("hashpower proof required")
		}

		minHashpower, ok := proof.Statement.Parameters["min_hashpower"].(float64)
		if !ok || minHashpower < m.config.MinHashpowerRequirement {
			return fmt.Errorf("minimum hashpower requirement not met: %.2f", m.config.MinHashpowerRequirement)
		}
	}

	// プルーフの検証
	result, err := m.zkpManager.VerifyProof(proof.ID, peerID)
	if err != nil {
		return fmt.Errorf("proof verification failed: %w", err)
	}

	if !result.Valid {
		return fmt.Errorf("invalid proof")
	}

	// レピュテーションスコアのチェック
	if m.config.RequireReputationProof && result.Reputation < m.config.MinReputationScore {
		return fmt.Errorf("reputation score too low: %.2f < %.2f", result.Reputation, m.config.MinReputationScore)
	}

	m.logger.Info("ZKP verification successful",
		zap.String("peer_id", peerID),
		zap.String("proof_id", proof.ID),
		zap.Float64("score", result.Score),
		zap.Float64("reputation", result.Reputation))

	return nil
}

// VerifyMiner はマイナーのZKP検証
func (m *ZKPAuthMiddleware) VerifyMiner(minerID string, proofID string) error {
	if !m.config.Enabled {
		return nil
	}

	result, err := m.zkpManager.VerifyProof(proofID, minerID)
	if err != nil {
		return fmt.Errorf("miner verification failed: %w", err)
	}

	if !result.Valid {
		return fmt.Errorf("invalid miner proof")
	}

	return nil
}

// HTTPMiddleware はHTTP API用のZKP認証ミドルウェア
func (m *ZKPAuthMiddleware) HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.config.Enabled {
			next.ServeHTTP(w, r)
			return
		}

		// ZKPヘッダーから証明IDを取得
		proofID := r.Header.Get("X-ZKP-Proof-ID")
		if proofID == "" {
			http.Error(w, "ZKP proof required", http.StatusUnauthorized)
			return
		}

		// クライアントIDを取得（IPアドレスまたはセッションIDから）
		clientID := r.RemoteAddr
		if sessionID := r.Header.Get("X-Session-ID"); sessionID != "" {
			clientID = sessionID
		}

		// プルーフの検証
		result, err := m.zkpManager.VerifyProof(proofID, clientID)
		if err != nil {
			m.logger.Error("ZKP verification failed",
				zap.String("client_id", clientID),
				zap.String("proof_id", proofID),
				zap.Error(err))
			http.Error(w, "ZKP verification failed", http.StatusUnauthorized)
			return
		}

		if !result.Valid {
			http.Error(w, "Invalid ZKP proof", http.StatusUnauthorized)
			return
		}

		// コンテキストに検証結果を追加
		ctx := context.WithValue(r.Context(), "zkp_result", result)
		ctx = context.WithValue(ctx, "zkp_verified", true)
		r = r.WithContext(ctx)

		next.ServeHTTP(w, r)
	})
}

// GenerateChallenge は新しいZKPチャレンジを生成
func (m *ZKPAuthMiddleware) GenerateChallenge(clientID string, challengeType zkp.StatementType) (*zkp.Statement, error) {
	statement := zkp.Statement{
		Type:       challengeType,
		Parameters: make(map[string]interface{}),
	}

	switch challengeType {
	case zkp.StatementAgeProof:
		statement.Parameters["min_age"] = float64(m.config.MinAgeRequirement)
		statement.Parameters["challenge_time"] = time.Now().Unix()

	case zkp.StatementHashPowerProof:
		statement.Parameters["min_hashpower"] = m.config.MinHashpowerRequirement
		statement.Parameters["difficulty"] = 1000.0 // 適切な難易度を設定

	case zkp.StatementComplianceProof:
		statement.Parameters["sanctions_check"] = true
		statement.Parameters["pep_check"] = true
		statement.Parameters["verification_level"] = "standard"

	default:
		return nil, fmt.Errorf("unsupported challenge type: %s", challengeType)
	}

	return &statement, nil
}

// CreateMinerProof はマイナー用のZKP証明を作成
func (m *ZKPAuthMiddleware) CreateMinerProof(minerID string, hashRate float64) (*zkp.Proof, error) {
	statement := zkp.Statement{
		Type: zkp.StatementHashPowerProof,
		Parameters: map[string]interface{}{
			"min_hashpower": m.config.MinHashpowerRequirement,
			"actual_hashpower": hashRate,
			"timestamp": time.Now().Unix(),
		},
	}

	// ウィットネス（秘密情報）を構築
	witness := fmt.Sprintf("miner:%s:hashrate:%.2f", minerID, hashRate)

	// プルーフを生成
	proof, err := m.zkpManager.GenerateProof(minerID, statement, []byte(witness))
	if err != nil {
		return nil, fmt.Errorf("failed to generate miner proof: %w", err)
	}

	m.logger.Info("Miner proof generated",
		zap.String("miner_id", minerID),
		zap.String("proof_id", proof.ID),
		zap.Float64("hash_rate", hashRate))

	return proof, nil
}

// CreatePoolOperatorProof はプールオペレーター用のZKP証明を作成
func (m *ZKPAuthMiddleware) CreatePoolOperatorProof(operatorID string, poolStats map[string]interface{}) (*zkp.Proof, error) {
	statement := zkp.Statement{
		Type: zkp.StatementReputationProof,
		Parameters: map[string]interface{}{
			"min_reputation": m.config.MinReputationScore,
			"pool_uptime": poolStats["uptime"],
			"total_miners": poolStats["total_miners"],
			"blocks_found": poolStats["blocks_found"],
		},
	}

	// プルーフを生成
	witness := fmt.Sprintf("operator:%s:stats:%v", operatorID, poolStats)
	proof, err := m.zkpManager.GenerateProof(operatorID, statement, []byte(witness))
	if err != nil {
		return nil, fmt.Errorf("failed to generate operator proof: %w", err)
	}

	return proof, nil
}

// ValidateAndRenewProof はプルーフの有効性を確認し、必要に応じて更新
func (m *ZKPAuthMiddleware) ValidateAndRenewProof(proofID string, clientID string) (*zkp.Proof, error) {
	// 既存のプルーフを検証
	result, err := m.zkpManager.VerifyProof(proofID, clientID)
	if err != nil {
		return nil, err
	}

	// プルーフが期限切れまたは無効な場合
	if !result.Valid || time.Since(result.VerifiedAt) > m.config.ProofExpiry {
		m.logger.Info("Proof expired or invalid, requesting renewal",
			zap.String("proof_id", proofID),
			zap.String("client_id", clientID))
		return nil, fmt.Errorf("proof renewal required")
	}

	// 有効なプルーフを返す（実際の実装では新しいプルーフを生成）
	return &zkp.Proof{
		ID:        proofID,
		ProverID:  clientID,
		CreatedAt: result.VerifiedAt,
		ExpiresAt: result.VerifiedAt.Add(m.config.ProofExpiry),
	}, nil
}

// GetRequiredProofs は必要なプルーフタイプのリストを返す
func (m *ZKPAuthMiddleware) GetRequiredProofs() []zkp.StatementType {
	var required []zkp.StatementType

	if m.config.RequireAgeProof {
		required = append(required, zkp.StatementAgeProof)
	}

	if m.config.RequireHashpowerProof {
		required = append(required, zkp.StatementHashPowerProof)
	}

	if m.config.RequireReputationProof {
		required = append(required, zkp.StatementReputationProof)
	}

	// コンプライアンス証明にZKPを使用
	required = append(required, zkp.StatementComplianceProof)

	return required
}

// AuditProofUsage はプルーフの使用状況を監査ログに記録
func (m *ZKPAuthMiddleware) AuditProofUsage(proofID string, action string, success bool) {
	if m.config.AuditLogEnabled {
		m.logger.Info("ZKP proof usage audit",
			zap.String("proof_id", proofID),
			zap.String("action", action),
			zap.Bool("success", success),
			zap.Time("timestamp", time.Now()))
	}
}