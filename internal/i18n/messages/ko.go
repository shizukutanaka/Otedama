// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import "github.com/shizukutanaka/Otedama/internal/i18n"

// Korean returns the Korean (ko) message catalog.
func Korean() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangKorean, map[i18n.ID]string{
		StartupReady:          "Otedama 준비 완료. 곧 채굴이 시작됩니다.",
		StartupWalletCreated:  "새 라이트닝 지갑이 생성되었습니다. 복구 시드가 이 기기에 안전하게 저장되어 있습니다.",
		StartupHardwareFound:  "채굴 장치 {{.count}}개를 감지했습니다: {{.summary}}",
		StartupHardwareNone:   "채굴 장치가 감지되지 않았습니다. Otedama에는 ASIC, GPU 또는 지원되는 CPU가 필요합니다.",
		StartupPoolConnecting: "풀 {{.url}}에 연결 중...",
		StartupPoolConnected:  "풀 {{.url}}에 연결되었습니다.",

		ErrorPoolUnreachable: "풀 {{.url}}에 연결할 수 없습니다. 인터넷 연결을 확인하거나 다른 풀을 시도해 보세요.",
		ErrorInvalidAddress:  "비트코인 주소 {{.address}}가 유효하지 않습니다. 오타를 확인해 주세요.",
		ErrorConfigMissing:   "채굴을 시작하려면 비트코인 주소가 필요합니다. --bitcoin-address 옵션을 사용하거나 OTEDAMA_BITCOIN_ADDRESS를 설정하세요.",
		ErrorWalletLocked:    "라이트닝 지갑이 잠겨 있습니다. 계속하려면 패스프레이즈로 잠금을 해제하세요.",
		ErrorHardwareFailure: "장치 {{.id}}에서 하드웨어 오류가 보고되어 비활성화되었습니다.",

		StatusMining:          "채굴 중: {{.devices}}개 장치, 현재 해시레이트: {{.hashrate}}.",
		StatusIdle:            "대기 중. 지금은 풀에서 작업이 없습니다.",
		StatusPaymentReceived: "풀 {{.pool}}에서 {{.amount}}를 수신했습니다.",
		StatusShuttingDown:    "정상 종료 중입니다. 지갑은 이 기기에 안전하게 보관됩니다.",
	})
}
