// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import (
	"github.com/shizukutanaka/Otedama/internal/i18n"
)

// Japanese returns the Japanese message catalog.
//
// Translation principles for Japanese:
//   - Technical terms that are widely used in Japanese crypto communities
//     (ハッシュレート, プール, ウォレット) are kept in katakana rather than
//     forced into native Japanese equivalents.
//   - Polite forms (です/ます) are minimized in favor of concise phrasing,
//     matching the user preference for terse technical output.
//   - Placeholders ({{.name}}) are left untouched so that upper-layer
//     text/template rendering works across languages.
func Japanese() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangJapanese, map[i18n.ID]string{
		StartupReady:          "Otedama起動完了。まもなくマイニング開始。",
		StartupWalletCreated:  "新規Lightningウォレットを作成。復元シードはこのデバイスに安全に保存済み。",
		StartupHardwareFound:  "マイニングデバイスを{{.count}}台検出: {{.summary}}",
		StartupHardwareNone:   "マイニングデバイス未検出。OtedamaにはASIC、GPU、対応CPUのいずれかが必要。",
		StartupPoolConnecting: "プール{{.url}}に接続中...",
		StartupPoolConnected:  "プール{{.url}}に接続完了。",

		ErrorPoolUnreachable: "プール{{.url}}に到達不可。インターネット接続を確認するか別のプールを試してください。",
		ErrorInvalidAddress:  "Bitcoinアドレス{{.address}}が無効。入力ミスを確認してください。",
		ErrorConfigMissing:   "OtedamaはBitcoinアドレスが必要。--bitcoin-addressを指定するかOTEDAMA_BITCOIN_ADDRESSを設定してください。",
		ErrorWalletLocked:    "Lightningウォレットがロック状態。パスフレーズで解錠してください。",
		ErrorHardwareFailure: "デバイス{{.id}}がハードウェア障害を報告。無効化済み。",

		StatusMining:          "マイニング中: デバイス{{.devices}}台、現在のハッシュレート{{.hashrate}}。",
		StatusIdle:            "待機中。プールから作業が届いていません。",
		StatusPaymentReceived: "プール{{.pool}}から{{.amount}}を受領。",
		StatusShuttingDown:    "正常終了中。ウォレットはこのデバイスに安全に保持されます。",
	})
}
