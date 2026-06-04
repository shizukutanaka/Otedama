// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import "github.com/shizukutanaka/Otedama/internal/i18n"

// Spanish returns the Spanish (es) message catalog.
func Spanish() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangSpanish, map[i18n.ID]string{
		StartupReady:          "Otedama está listo. La minería comenzará en breve.",
		StartupWalletCreated:  "Se ha creado una nueva cartera Lightning. Tu semilla de recuperación está almacenada de forma segura en este dispositivo.",
		StartupHardwareFound:  "Se detectaron {{.count}} dispositivos de minería: {{.summary}}",
		StartupHardwareNone:   "No se detectaron dispositivos de minería. Otedama requiere un ASIC, GPU o CPU compatible.",
		StartupPoolConnecting: "Conectando al pool {{.url}}...",
		StartupPoolConnected:  "Conectado al pool {{.url}}.",

		ErrorPoolUnreachable: "El pool {{.url}} no es accesible. Verifica tu conexión a Internet o prueba con otro pool.",
		ErrorInvalidAddress:  "La dirección Bitcoin {{.address}} no es válida. Por favor verifica si hay errores tipográficos.",
		ErrorConfigMissing:   "Otedama necesita una dirección Bitcoin antes de comenzar la minería. Pasa --bitcoin-address o establece OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "La cartera Lightning está bloqueada. Desbloquéala con tu frase de contraseña para continuar.",
		ErrorHardwareFailure: "El dispositivo {{.id}} reportó un fallo de hardware y ha sido deshabilitado.",

		StatusMining:          "Minando en {{.devices}} dispositivo(s). Tasa de hash actual: {{.hashrate}}.",
		StatusIdle:            "Inactivo. No hay trabajo disponible del pool en este momento.",
		StatusPaymentReceived: "Recibido {{.amount}} del pool {{.pool}}.",
		StatusShuttingDown:    "Apagando de forma segura. Tu cartera permanece a salvo en este dispositivo.",
	})
}
