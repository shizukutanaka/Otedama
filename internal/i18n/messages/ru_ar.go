// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import "github.com/shizukutanaka/Otedama/internal/i18n"

// Russian returns the Russian (ru) message catalog.
func Russian() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangRussian, map[i18n.ID]string{
		StartupReady:          "Otedama готов. Майнинг начнётся в ближайшее время.",
		StartupWalletCreated:  "Создан новый кошелёк Lightning. Фраза восстановления надёжно сохранена на этом устройстве.",
		StartupHardwareFound:  "Обнаружено {{.count}} майнинговых устройств: {{.summary}}",
		StartupHardwareNone:   "Майнинговые устройства не обнаружены. Otedama требует ASIC, GPU или совместимый CPU.",
		StartupPoolConnecting: "Подключение к пулу {{.url}}...",
		StartupPoolConnected:  "Подключено к пулу {{.url}}.",

		ErrorPoolUnreachable: "Пул {{.url}} недоступен. Проверьте подключение к интернету или попробуйте другой пул.",
		ErrorInvalidAddress:  "Адрес Bitcoin {{.address}} недействителен. Проверьте правильность написания.",
		ErrorConfigMissing:   "Otedama требует адрес Bitcoin для начала майнинга. Передайте --bitcoin-address или установите OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "Кошелёк Lightning заблокирован. Разблокируйте его с помощью пароля для продолжения.",
		ErrorHardwareFailure: "Устройство {{.id}} сообщило об аппаратной ошибке и было отключено.",

		StatusMining:          "Майнинг на {{.devices}} устройствах. Текущий хешрейт: {{.hashrate}}.",
		StatusIdle:            "Простой. В данный момент пул не предоставляет задания.",
		StatusPaymentReceived: "Получено {{.amount}} от пула {{.pool}}.",
		StatusShuttingDown:    "Корректное завершение работы. Ваш кошелёк в безопасности на этом устройстве.",
	})
}

// Arabic returns the Arabic (ar) message catalog.
// Note: Arabic is RTL; placeholder positions follow the natural Arabic
// sentence structure rather than mirroring the English word order.
func Arabic() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangArabic, map[i18n.ID]string{
		StartupReady:          "Otedama جاهز. سيبدأ التعدين قريبًا.",
		StartupWalletCreated:  "تم إنشاء محفظة Lightning جديدة. تم تخزين عبارة الاسترداد بأمان على هذا الجهاز.",
		StartupHardwareFound:  "تم اكتشاف {{.count}} جهاز تعدين: {{.summary}}",
		StartupHardwareNone:   "لم يتم اكتشاف أجهزة تعدين. يتطلب Otedama ASIC أو GPU أو CPU متوافق.",
		StartupPoolConnecting: "جارٍ الاتصال بالمجمع {{.url}}...",
		StartupPoolConnected:  "تم الاتصال بالمجمع {{.url}}.",

		ErrorPoolUnreachable: "المجمع {{.url}} غير قابل للوصول. تحقق من اتصالك بالإنترنت أو جرّب مجمعًا مختلفًا.",
		ErrorInvalidAddress:  "عنوان Bitcoin {{.address}} غير صالح. يرجى التحقق من الأخطاء المطبعية.",
		ErrorConfigMissing:   "يحتاج Otedama إلى عنوان Bitcoin قبل بدء التعدين. مرّر --bitcoin-address أو اضبط OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "محفظة Lightning مقفلة. افتحها بعبارة المرور للمتابعة.",
		ErrorHardwareFailure: "أبلغ الجهاز {{.id}} عن عطل في الأجهزة وتم تعطيله.",

		StatusMining:          "جارٍ التعدين على {{.devices}} جهاز. معدل التجزئة الحالي: {{.hashrate}}.",
		StatusIdle:            "خامل. لا يوجد عمل متاح من المجمع حاليًا.",
		StatusPaymentReceived: "تم استلام {{.amount}} من المجمع {{.pool}}.",
		StatusShuttingDown:    "إيقاف التشغيل بأمان. تظل محفظتك في أمان على هذا الجهاز.",
	})
}
