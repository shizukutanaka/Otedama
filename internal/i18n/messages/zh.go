// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import "github.com/shizukutanaka/Otedama/internal/i18n"

// Chinese returns the Simplified Chinese (zh-CN) message catalog.
func Chinese() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangChinese, map[i18n.ID]string{
		StartupReady:          "Otedama 已就绪。即将开始挖矿。",
		StartupWalletCreated:  "已创建新的闪电网络钱包。您的恢复助记词已安全存储在本设备上。",
		StartupHardwareFound:  "检测到 {{.count}} 台挖矿设备：{{.summary}}",
		StartupHardwareNone:   "未检测到挖矿设备。Otedama 需要 ASIC、GPU 或受支持的 CPU。",
		StartupPoolConnecting: "正在连接到矿池 {{.url}}...",
		StartupPoolConnected:  "已连接到矿池 {{.url}}。",

		ErrorPoolUnreachable: "无法到达矿池 {{.url}}。请检查网络连接或尝试其他矿池。",
		ErrorInvalidAddress:  "比特币地址 {{.address}} 无效。请检查是否有拼写错误。",
		ErrorConfigMissing:   "Otedama 需要比特币地址才能开始挖矿。请通过 --bitcoin-address 传入或设置 OTEDAMA_BITCOIN_ADDRESS。",
		ErrorWalletLocked:    "闪电网络钱包已锁定。请使用密码短语解锁以继续。",
		ErrorHardwareFailure: "设备 {{.id}} 报告硬件故障，已被禁用。",

		StatusMining:          "挖矿中：{{.devices}} 台设备，当前哈希率：{{.hashrate}}。",
		StatusIdle:            "空闲中。当前矿池暂无工作任务。",
		StatusPaymentReceived: "已从矿池 {{.pool}} 收到 {{.amount}}。",
		StatusShuttingDown:    "正在优雅关闭。您的钱包已安全保存在本设备上。",
	})
}
