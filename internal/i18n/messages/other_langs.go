// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import "github.com/shizukutanaka/Otedama/internal/i18n"

// French returns the French (fr) message catalog.
func French() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangFrench, map[i18n.ID]string{
		StartupReady:          "Otedama est prêt. Le minage va commencer sous peu.",
		StartupWalletCreated:  "Un nouveau portefeuille Lightning a été créé. Votre phrase de récupération est stockée en sécurité sur cet appareil.",
		StartupHardwareFound:  "{{.count}} appareil(s) de minage détecté(s) : {{.summary}}",
		StartupHardwareNone:   "Aucun appareil de minage détecté. Otedama nécessite un ASIC, un GPU ou un CPU compatible.",
		StartupPoolConnecting: "Connexion au pool {{.url}} en cours...",
		StartupPoolConnected:  "Connecté au pool {{.url}}.",

		ErrorPoolUnreachable: "Le pool {{.url}} est inaccessible. Vérifiez votre connexion Internet ou essayez un autre pool.",
		ErrorInvalidAddress:  "L'adresse Bitcoin {{.address}} n'est pas valide. Vérifiez l'absence de fautes de frappe.",
		ErrorConfigMissing:   "Otedama a besoin d'une adresse Bitcoin pour commencer le minage. Passez --bitcoin-address ou définissez OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "Le portefeuille Lightning est verrouillé. Déverrouillez-le avec votre phrase de passe pour continuer.",
		ErrorHardwareFailure: "L'appareil {{.id}} a signalé une défaillance matérielle et a été désactivé.",

		StatusMining:          "Minage en cours sur {{.devices}} appareil(s). Taux de hachage actuel : {{.hashrate}}.",
		StatusIdle:            "Inactif. Aucun travail disponible depuis le pool pour le moment.",
		StatusPaymentReceived: "{{.amount}} reçu depuis le pool {{.pool}}.",
		StatusShuttingDown:    "Arrêt en cours. Votre portefeuille reste sécurisé sur cet appareil.",
	})
}

// German returns the German (de) message catalog.
func German() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangGerman, map[i18n.ID]string{
		StartupReady:          "Otedama ist bereit. Mining beginnt in Kürze.",
		StartupWalletCreated:  "Ein neues Lightning-Wallet wurde erstellt. Ihr Wiederherstellungs-Seed ist sicher auf diesem Gerät gespeichert.",
		StartupHardwareFound:  "{{.count}} Mining-Gerät(e) erkannt: {{.summary}}",
		StartupHardwareNone:   "Keine Mining-Geräte erkannt. Otedama benötigt einen ASIC, eine GPU oder eine unterstützte CPU.",
		StartupPoolConnecting: "Verbindung zu Pool {{.url}} wird hergestellt...",
		StartupPoolConnected:  "Mit Pool {{.url}} verbunden.",

		ErrorPoolUnreachable: "Der Pool {{.url}} ist nicht erreichbar. Überprüfen Sie Ihre Internetverbindung oder versuchen Sie einen anderen Pool.",
		ErrorInvalidAddress:  "Die Bitcoin-Adresse {{.address}} ist ungültig. Bitte auf Tippfehler überprüfen.",
		ErrorConfigMissing:   "Otedama benötigt eine Bitcoin-Adresse, bevor das Mining beginnen kann. Übergeben Sie --bitcoin-address oder setzen Sie OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "Das Lightning-Wallet ist gesperrt. Entsperren Sie es mit Ihrer Passphrase, um fortzufahren.",
		ErrorHardwareFailure: "Gerät {{.id}} hat einen Hardwarefehler gemeldet und wurde deaktiviert.",

		StatusMining:          "Mining auf {{.devices}} Gerät(en). Aktuelle Hashrate: {{.hashrate}}.",
		StatusIdle:            "Inaktiv. Derzeit keine Arbeit vom Pool verfügbar.",
		StatusPaymentReceived: "{{.amount}} von Pool {{.pool}} empfangen.",
		StatusShuttingDown:    "Wird sicher heruntergefahren. Ihr Wallet bleibt auf diesem Gerät sicher.",
	})
}

// Portuguese returns the Portuguese (pt) message catalog.
func Portuguese() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangPortuguese, map[i18n.ID]string{
		StartupReady:          "Otedama está pronto. A mineração começará em breve.",
		StartupWalletCreated:  "Uma nova carteira Lightning foi criada. Sua semente de recuperação está armazenada com segurança neste dispositivo.",
		StartupHardwareFound:  "{{.count}} dispositivo(s) de mineração detectado(s): {{.summary}}",
		StartupHardwareNone:   "Nenhum dispositivo de mineração detectado. O Otedama requer um ASIC, GPU ou CPU compatível.",
		StartupPoolConnecting: "Conectando ao pool {{.url}}...",
		StartupPoolConnected:  "Conectado ao pool {{.url}}.",

		ErrorPoolUnreachable: "O pool {{.url}} está inacessível. Verifique sua conexão com a Internet ou tente outro pool.",
		ErrorInvalidAddress:  "O endereço Bitcoin {{.address}} não é válido. Por favor, verifique se há erros de digitação.",
		ErrorConfigMissing:   "O Otedama precisa de um endereço Bitcoin antes de começar a mineração. Passe --bitcoin-address ou defina OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "A carteira Lightning está bloqueada. Desbloqueie-a com sua frase secreta para continuar.",
		ErrorHardwareFailure: "O dispositivo {{.id}} relatou uma falha de hardware e foi desativado.",

		StatusMining:          "Minerando em {{.devices}} dispositivo(s). Taxa de hash atual: {{.hashrate}}.",
		StatusIdle:            "Inativo. Nenhum trabalho disponível no pool agora.",
		StatusPaymentReceived: "Recebido {{.amount}} do pool {{.pool}}.",
		StatusShuttingDown:    "Encerrando com segurança. Sua carteira permanece segura neste dispositivo.",
	})
}
