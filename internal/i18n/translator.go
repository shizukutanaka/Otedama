package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

//go:embed translations/*.json
var translationsFS embed.FS

// Translator handles internationalization for 100+ languages
type Translator struct {
	translations map[string]map[string]string
	currentLang  string
	fallbackLang string
	mu           sync.RWMutex
}

// SupportedLanguages lists all supported languages
var SupportedLanguages = map[string]string{
	"en":    "English",
	"ja":    "日本語",
	"zh":    "中文",
	"zh-TW": "繁體中文",
	"ko":    "한국어",
	"es":    "Español",
	"fr":    "Français",
	"de":    "Deutsch",
	"it":    "Italiano",
	"pt":    "Português",
	"pt-BR": "Português (Brasil)",
	"ru":    "Русский",
	"ar":    "العربية",
	"hi":    "हिन्दी",
	"th":    "ไทย",
	"vi":    "Tiếng Việt",
	"id":    "Bahasa Indonesia",
	"ms":    "Bahasa Melayu",
	"tr":    "Türkçe",
	"pl":    "Polski",
	"nl":    "Nederlands",
	"sv":    "Svenska",
	"no":    "Norsk",
	"da":    "Dansk",
	"fi":    "Suomi",
	"cs":    "Čeština",
	"sk":    "Slovenčina",
	"hu":    "Magyar",
	"ro":    "Română",
	"bg":    "Български",
	"hr":    "Hrvatski",
	"sr":    "Српски",
	"sl":    "Slovenščina",
	"uk":    "Українська",
	"el":    "Ελληνικά",
	"he":    "עברית",
	"fa":    "فارسی",
	"ur":    "اردو",
	"bn":    "বাংলা",
	"ta":    "தமிழ்",
	"te":    "తెలుగు",
	"mr":    "मराठी",
	"gu":    "ગુજરાતી",
	"kn":    "ಕನ್ನಡ",
	"ml":    "മലയാളം",
	"pa":    "ਪੰਜਾਬੀ",
	"ne":    "नेपाली",
	"si":    "සිංහල",
	"my":    "မြန်မာ",
	"km":    "ខ្មែរ",
	"lo":    "ລາວ",
	"ka":    "ქართული",
	"am":    "አማርኛ",
	"sw":    "Kiswahili",
	"yo":    "Yorùbá",
	"zu":    "isiZulu",
	"xh":    "isiXhosa",
	"af":    "Afrikaans",
	"sq":    "Shqip",
	"eu":    "Euskara",
	"be":    "Беларуская",
	"bs":    "Bosanski",
	"ca":    "Català",
	"co":    "Corsu",
	"cy":    "Cymraeg",
	"eo":    "Esperanto",
	"et":    "Eesti",
	"fo":    "Føroyskt",
	"fy":    "Frysk",
	"ga":    "Gaeilge",
	"gd":    "Gàidhlig",
	"gl":    "Galego",
	"ha":    "Hausa",
	"haw":   "ʻŌlelo Hawaiʻi",
	"hmn":   "Hmong",
	"ht":    "Kreyòl Ayisyen",
	"ig":    "Igbo",
	"is":    "Íslenska",
	"jw":    "Basa Jawa",
	"kk":    "Қазақ",
	"ku":    "Kurdî",
	"ky":    "Кыргызча",
	"la":    "Latina",
	"lb":    "Lëtzebuergesch",
	"lt":    "Lietuvių",
	"lv":    "Latviešu",
	"mg":    "Malagasy",
	"mi":    "Te Reo Māori",
	"mk":    "Македонски",
	"mn":    "Монгол",
	"mt":    "Malti",
	"ny":    "Chichewa",
	"ps":    "پښتو",
	"sm":    "Gagana Samoa",
	"sn":    "chiShona",
	"so":    "Soomaali",
	"st":    "Sesotho",
	"su":    "Basa Sunda",
	"tg":    "Тоҷикӣ",
	"tl":    "Filipino",
	"tt":    "Татарча",
	"ug":    "ئۇيغۇرچە",
	"uz":    "Oʻzbek",
	"yi":    "ייִדיש",
}

// TranslationKeys defines all translation keys
var TranslationKeys = struct {
	// Dashboard
	Dashboard           string
	Hashrate            string
	Temperature         string
	Power               string
	Shares              string
	Efficiency          string
	Uptime              string
	Workers             string
	
	// Mining
	StartMining         string
	StopMining          string
	Algorithm           string
	Pool                string
	Wallet              string
	Difficulty          string
	BlockHeight         string
	NetworkHashrate     string
	
	// Status
	Online              string
	Offline             string
	Mining              string
	Idle                string
	Connected           string
	Disconnected        string
	
	// Settings
	Settings            string
	General             string
	Network             string
	Security            string
	Advanced            string
	Language            string
	Theme               string
	SaveSettings        string
	
	// Errors
	Error               string
	Warning             string
	Info                string
	Success             string
	ConnectionError     string
	InvalidConfiguration string
	
	// Actions
	Start               string
	Stop                string
	Restart             string
	Apply               string
	Cancel              string
	OK                  string
	Close               string
	
	// Statistics
	Statistics          string
	TotalShares         string
	AcceptedShares      string
	RejectedShares      string
	RejectRate          string
	AverageHashrate     string
	CurrentHashrate     string
	
	// Profit
	Profitability       string
	Revenue             string
	ElectricityCost     string
	NetProfit           string
	DailyEarnings       string
	MonthlyEarnings     string
	ROI                 string
}{
	// Dashboard
	Dashboard:           "dashboard",
	Hashrate:            "hashrate",
	Temperature:         "temperature",
	Power:               "power",
	Shares:              "shares",
	Efficiency:          "efficiency",
	Uptime:              "uptime",
	Workers:             "workers",
	
	// Mining
	StartMining:         "start_mining",
	StopMining:          "stop_mining",
	Algorithm:           "algorithm",
	Pool:                "pool",
	Wallet:              "wallet",
	Difficulty:          "difficulty",
	BlockHeight:         "block_height",
	NetworkHashrate:     "network_hashrate",
	
	// Status
	Online:              "online",
	Offline:             "offline",
	Mining:              "mining",
	Idle:                "idle",
	Connected:           "connected",
	Disconnected:        "disconnected",
	
	// Settings
	Settings:            "settings",
	General:             "general",
	Network:             "network",
	Security:            "security",
	Advanced:            "advanced",
	Language:            "language",
	Theme:               "theme",
	SaveSettings:        "save_settings",
	
	// Errors
	Error:               "error",
	Warning:             "warning",
	Info:                "info",
	Success:             "success",
	ConnectionError:     "connection_error",
	InvalidConfiguration: "invalid_configuration",
	
	// Actions
	Start:               "start",
	Stop:                "stop",
	Restart:             "restart",
	Apply:               "apply",
	Cancel:              "cancel",
	OK:                  "ok",
	Close:               "close",
	
	// Statistics
	Statistics:          "statistics",
	TotalShares:         "total_shares",
	AcceptedShares:      "accepted_shares",
	RejectedShares:      "rejected_shares",
	RejectRate:          "reject_rate",
	AverageHashrate:     "average_hashrate",
	CurrentHashrate:     "current_hashrate",
	
	// Profit
	Profitability:       "profitability",
	Revenue:             "revenue",
	ElectricityCost:     "electricity_cost",
	NetProfit:           "net_profit",
	DailyEarnings:       "daily_earnings",
	MonthlyEarnings:     "monthly_earnings",
	ROI:                 "roi",
}

// NewTranslator creates a new translator
func NewTranslator(defaultLang string) *Translator {
	t := &Translator{
		translations: make(map[string]map[string]string),
		currentLang:  defaultLang,
		fallbackLang: "en",
	}
	
	// Load translations
	t.loadTranslations()
	
	return t
}

// SetLanguage sets the current language
func (t *Translator) SetLanguage(lang string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	
	if _, exists := SupportedLanguages[lang]; !exists {
		return fmt.Errorf("unsupported language: %s", lang)
	}
	
	t.currentLang = lang
	return nil
}

// Get translates a key to the current language
func (t *Translator) Get(key string, args ...interface{}) string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	
	// Try current language
	if trans, exists := t.translations[t.currentLang]; exists {
		if value, ok := trans[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(value, args...)
			}
			return value
		}
	}
	
	// Fall back to English
	if trans, exists := t.translations[t.fallbackLang]; exists {
		if value, ok := trans[key]; ok {
			if len(args) > 0 {
				return fmt.Sprintf(value, args...)
			}
			return value
		}
	}
	
	// Return key if no translation found
	return key
}

// GetLanguage returns the current language
func (t *Translator) GetLanguage() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.currentLang
}

// GetAvailableLanguages returns all available languages
func (t *Translator) GetAvailableLanguages() map[string]string {
	return SupportedLanguages
}

// loadTranslations loads all translation files
func (t *Translator) loadTranslations() {
	// Load English translations (base)
	t.translations["en"] = map[string]string{
		"dashboard":           "Dashboard",
		"hashrate":            "Hashrate",
		"temperature":         "Temperature",
		"power":               "Power",
		"shares":              "Shares",
		"efficiency":          "Efficiency",
		"uptime":              "Uptime",
		"workers":             "Workers",
		"start_mining":        "Start Mining",
		"stop_mining":         "Stop Mining",
		"algorithm":           "Algorithm",
		"pool":                "Pool",
		"wallet":              "Wallet",
		"difficulty":          "Difficulty",
		"block_height":        "Block Height",
		"network_hashrate":    "Network Hashrate",
		"online":              "Online",
		"offline":             "Offline",
		"mining":              "Mining",
		"idle":                "Idle",
		"connected":           "Connected",
		"disconnected":        "Disconnected",
		"settings":            "Settings",
		"general":             "General",
		"network":             "Network",
		"security":            "Security",
		"advanced":            "Advanced",
		"language":            "Language",
		"theme":               "Theme",
		"save_settings":       "Save Settings",
		"error":               "Error",
		"warning":             "Warning",
		"info":                "Information",
		"success":             "Success",
		"connection_error":    "Connection Error",
		"invalid_configuration": "Invalid Configuration",
		"start":               "Start",
		"stop":                "Stop",
		"restart":             "Restart",
		"apply":               "Apply",
		"cancel":              "Cancel",
		"ok":                  "OK",
		"close":               "Close",
		"statistics":          "Statistics",
		"total_shares":        "Total Shares",
		"accepted_shares":     "Accepted Shares",
		"rejected_shares":     "Rejected Shares",
		"reject_rate":         "Reject Rate",
		"average_hashrate":    "Average Hashrate",
		"current_hashrate":    "Current Hashrate",
		"profitability":       "Profitability",
		"revenue":             "Revenue",
		"electricity_cost":    "Electricity Cost",
		"net_profit":          "Net Profit",
		"daily_earnings":      "Daily Earnings",
		"monthly_earnings":    "Monthly Earnings",
		"roi":                 "ROI",
	}
	
	// Load Japanese translations
	t.translations["ja"] = map[string]string{
		"dashboard":           "ダッシュボード",
		"hashrate":            "ハッシュレート",
		"temperature":         "温度",
		"power":               "電力",
		"shares":              "シェア",
		"efficiency":          "効率",
		"uptime":              "稼働時間",
		"workers":             "ワーカー",
		"start_mining":        "マイニング開始",
		"stop_mining":         "マイニング停止",
		"algorithm":           "アルゴリズム",
		"pool":                "プール",
		"wallet":              "ウォレット",
		"difficulty":          "難易度",
		"block_height":        "ブロック高",
		"network_hashrate":    "ネットワークハッシュレート",
		"online":              "オンライン",
		"offline":             "オフライン",
		"mining":              "マイニング中",
		"idle":                "アイドル",
		"connected":           "接続済み",
		"disconnected":        "切断",
		"settings":            "設定",
		"general":             "一般",
		"network":             "ネットワーク",
		"security":            "セキュリティ",
		"advanced":            "詳細",
		"language":            "言語",
		"theme":               "テーマ",
		"save_settings":       "設定を保存",
		"error":               "エラー",
		"warning":             "警告",
		"info":                "情報",
		"success":             "成功",
		"connection_error":    "接続エラー",
		"invalid_configuration": "無効な設定",
		"start":               "開始",
		"stop":                "停止",
		"restart":             "再起動",
		"apply":               "適用",
		"cancel":              "キャンセル",
		"ok":                  "OK",
		"close":               "閉じる",
		"statistics":          "統計",
		"total_shares":        "総シェア数",
		"accepted_shares":     "承認シェア",
		"rejected_shares":     "拒否シェア",
		"reject_rate":         "拒否率",
		"average_hashrate":    "平均ハッシュレート",
		"current_hashrate":    "現在のハッシュレート",
		"profitability":       "収益性",
		"revenue":             "収益",
		"electricity_cost":    "電気代",
		"net_profit":          "純利益",
		"daily_earnings":      "日収",
		"monthly_earnings":    "月収",
		"roi":                 "投資収益率",
	}
	
	// Load Chinese translations
	t.translations["zh"] = map[string]string{
		"dashboard":           "仪表板",
		"hashrate":            "算力",
		"temperature":         "温度",
		"power":               "功率",
		"shares":              "份额",
		"efficiency":          "效率",
		"uptime":              "运行时间",
		"workers":             "矿工",
		"start_mining":        "开始挖矿",
		"stop_mining":         "停止挖矿",
		"algorithm":           "算法",
		"pool":                "矿池",
		"wallet":              "钱包",
		"difficulty":          "难度",
		"block_height":        "区块高度",
		"network_hashrate":    "全网算力",
		"online":              "在线",
		"offline":             "离线",
		"mining":              "挖矿中",
		"idle":                "空闲",
		"connected":           "已连接",
		"disconnected":        "已断开",
		"settings":            "设置",
		"general":             "常规",
		"network":             "网络",
		"security":            "安全",
		"advanced":            "高级",
		"language":            "语言",
		"theme":               "主题",
		"save_settings":       "保存设置",
		"error":               "错误",
		"warning":             "警告",
		"info":                "信息",
		"success":             "成功",
		"connection_error":    "连接错误",
		"invalid_configuration": "配置无效",
		"start":               "开始",
		"stop":                "停止",
		"restart":             "重启",
		"apply":               "应用",
		"cancel":              "取消",
		"ok":                  "确定",
		"close":               "关闭",
		"statistics":          "统计",
		"total_shares":        "总份额",
		"accepted_shares":     "接受份额",
		"rejected_shares":     "拒绝份额",
		"reject_rate":         "拒绝率",
		"average_hashrate":    "平均算力",
		"current_hashrate":    "当前算力",
		"profitability":       "收益率",
		"revenue":             "收入",
		"electricity_cost":    "电费",
		"net_profit":          "净利润",
		"daily_earnings":      "日收益",
		"monthly_earnings":    "月收益",
		"roi":                 "投资回报率",
	}
	
	// Additional languages would be loaded from embedded files
	// This is a simplified implementation
}

// Format formats a number with locale-specific formatting
func (t *Translator) FormatNumber(value float64) string {
	// Simplified number formatting based on language
	switch t.currentLang {
	case "en":
		return fmt.Sprintf("%.2f", value)
	case "ja":
		return fmt.Sprintf("%.2f", value)
	case "zh":
		return fmt.Sprintf("%.2f", value)
	default:
		return fmt.Sprintf("%.2f", value)
	}
}

// FormatCurrency formats a currency value
func (t *Translator) FormatCurrency(value float64, currency string) string {
	symbol := "$"
	switch currency {
	case "USD":
		symbol = "$"
	case "EUR":
		symbol = "€"
	case "GBP":
		symbol = "£"
	case "JPY":
		symbol = "¥"
	case "CNY":
		symbol = "¥"
	case "KRW":
		symbol = "₩"
	case "BTC":
		symbol = "₿"
	case "ETH":
		symbol = "Ξ"
	}
	
	return fmt.Sprintf("%s%.2f", symbol, value)
}

// FormatHashrate formats hashrate with appropriate units
func (t *Translator) FormatHashrate(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"}
	unitIndex := 0
	
	for hashrate >= 1000 && unitIndex < len(units)-1 {
		hashrate /= 1000
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f %s", hashrate, units[unitIndex])
}

// DetectLanguage detects language from Accept-Language header
func DetectLanguage(acceptLanguage string) string {
	// Parse Accept-Language header
	languages := strings.Split(acceptLanguage, ",")
	
	for _, lang := range languages {
		// Extract language code
		parts := strings.Split(strings.TrimSpace(lang), ";")
		code := strings.ToLower(strings.TrimSpace(parts[0]))
		
		// Check if we support this language
		if _, exists := SupportedLanguages[code]; exists {
			return code
		}
		
		// Try without region code
		if idx := strings.Index(code, "-"); idx != -1 {
			baseCode := code[:idx]
			if _, exists := SupportedLanguages[baseCode]; exists {
				return baseCode
			}
		}
	}
	
	// Default to English
	return "en"
}

// Global translator instance
var Global *Translator

func init() {
	Global = NewTranslator("en")
}

// T is a shorthand for Global.Get
func T(key string, args ...interface{}) string {
	return Global.Get(key, args...)
}

// SetGlobalLanguage sets the global language
func SetGlobalLanguage(lang string) error {
	return Global.SetLanguage(lang)
}
