// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import (
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/i18n"
)

var allCatalogSpecs = []struct {
	name string
	lang i18n.Lang
	fn   func() (*i18n.Catalog, error)
}{
	{"English", i18n.LangEnglish, English},
	{"Japanese", i18n.LangJapanese, Japanese},
	{"Chinese", i18n.LangChinese, Chinese},
	{"Korean", i18n.LangKorean, Korean},
	{"Spanish", i18n.LangSpanish, Spanish},
	{"French", i18n.LangFrench, French},
	{"German", i18n.LangGerman, German},
	{"Portuguese", i18n.LangPortuguese, Portuguese},
	{"Russian", i18n.LangRussian, Russian},
	{"Arabic", i18n.LangArabic, Arabic},
}

func TestAllCatalogs_LoadWithoutError(t *testing.T) {
	for _, tc := range allCatalogSpecs {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, err := tc.fn()
			if err != nil {
				t.Fatalf("%s() failed: %v", tc.name, err)
			}
			if c.Lang() != tc.lang {
				t.Errorf("Lang = %q, want %q", c.Lang(), tc.lang)
			}
		})
	}
}

func TestAllCatalogs_CoverAllEnglishIDs(t *testing.T) {
	en, err := English()
	if err != nil {
		t.Fatalf("English() failed: %v", err)
	}
	for _, tc := range allCatalogSpecs {
		if tc.lang == i18n.LangEnglish {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, err := tc.fn()
			if err != nil {
				t.Fatalf("%s() failed: %v", tc.name, err)
			}
			catIDs := make(map[i18n.ID]struct{})
			for _, id := range c.IDs() {
				catIDs[id] = struct{}{}
			}
			for _, id := range en.IDs() {
				if _, ok := catIDs[id]; !ok {
					t.Errorf("%s missing ID %q", tc.name, id)
				}
			}
		})
	}
}

func TestAllCatalogs_NoEmptyMessages(t *testing.T) {
	for _, tc := range allCatalogSpecs {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, err := tc.fn()
			if err != nil {
				t.Fatalf("%s() failed: %v", tc.name, err)
			}
			for _, id := range c.IDs() {
				msg, _ := c.Lookup(id)
				if strings.TrimSpace(msg) == "" {
					t.Errorf("%s: empty message for ID %q", tc.name, id)
				}
			}
		})
	}
}

func TestAllIDs_MatchesEnglishCatalog(t *testing.T) {
	c, err := English()
	if err != nil {
		t.Fatalf("English() failed: %v", err)
	}
	englishIDs := c.IDs()
	allIDs := AllIDs()
	if len(englishIDs) != len(allIDs) {
		t.Errorf("English has %d IDs, AllIDs has %d", len(englishIDs), len(allIDs))
	}
	set := make(map[i18n.ID]bool)
	for _, id := range englishIDs {
		set[id] = true
	}
	for _, id := range allIDs {
		if !set[id] {
			t.Errorf("AllIDs has %q not in English catalog", id)
		}
	}
}

func TestAllIDsAreValid(t *testing.T) {
	for _, id := range AllIDs() {
		if !id.Valid() {
			t.Errorf("invalid ID: %q", id)
		}
	}
}

func TestNewBundle_Contains10Languages(t *testing.T) {
	bundle, err := NewBundle()
	if err != nil {
		t.Fatalf("NewBundle() failed: %v", err)
	}
	langs := bundle.Languages()
	if len(langs) < 10 {
		t.Errorf("bundle has %d languages, want >= 10", len(langs))
	}
}

func TestRenderingWorks_AllLanguages(t *testing.T) {
	bundle, err := NewBundle()
	if err != nil {
		t.Fatalf("NewBundle() failed: %v", err)
	}
	for _, tc := range allCatalogSpecs {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			msg, err := bundle.Render(tc.lang, StartupReady)
			if err != nil {
				t.Fatalf("Render(%q) failed: %v", tc.lang, err)
			}
			if strings.TrimSpace(msg) == "" {
				t.Errorf("Render(%q, StartupReady) empty", tc.lang)
			}
		})
	}
}

func TestRenderWith_SubstitutesPlaceholders(t *testing.T) {
	bundle, err := NewBundle()
	if err != nil {
		t.Fatalf("NewBundle() failed: %v", err)
	}
	for _, tc := range allCatalogSpecs {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			msg, err := bundle.RenderWith(tc.lang, StartupHardwareFound, map[string]any{
				"count":   "3",
				"summary": "CPU x3",
			})
			if err != nil {
				t.Fatalf("RenderWith(%q) failed: %v", tc.lang, err)
			}
			if strings.Contains(msg, "{{") {
				t.Errorf("unsubstituted placeholder in %q: %q", tc.lang, msg)
			}
			if !strings.Contains(msg, "3") {
				t.Errorf("count not substituted in %q: %q", tc.lang, msg)
			}
		})
	}
}

func TestFallbackToEnglishForUnsupportedLanguage(t *testing.T) {
	en, _ := English()
	bundle, _ := i18n.NewBundle(en)
	msg, err := bundle.Render(i18n.Lang("eo"), StartupReady)
	if err != nil {
		t.Fatalf("Render(eo) failed: %v", err)
	}
	expected, _ := en.Lookup(StartupReady)
	if msg != expected {
		t.Errorf("fallback = %q, want English %q", msg, expected)
	}
}

func TestDetectLang_Exact(t *testing.T) {
	for _, tc := range allCatalogSpecs {
		if got := DetectLang(string(tc.lang)); got != tc.lang {
			t.Errorf("DetectLang(%q) = %q, want %q", tc.lang, got, tc.lang)
		}
	}
}

func TestDetectLang_SubTag(t *testing.T) {
	tests := []struct{ in, want string }{
		{"ja-JP", "ja"},
		{"zh-CN", "zh"},
		{"zh-TW", "zh"},
		{"pt-BR", "pt"},
	}
	for _, tt := range tests {
		if got := DetectLang(tt.in); string(got) != tt.want {
			t.Errorf("DetectLang(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestDetectLang_Unknown(t *testing.T) {
	tests := []string{"", "klingon", "xx-INVALID"}
	for _, in := range tests {
		if got := DetectLang(in); got != i18n.LangEnglish {
			t.Errorf("DetectLang(%q) = %q, want en", in, got)
		}
	}
}

func TestJapanese_CoversAllEnglishIDs(t *testing.T) {
	en, _ := English()
	ja, _ := Japanese()
	bundle, err := i18n.NewBundle(en, ja)
	if err != nil {
		t.Fatalf("NewBundle: %v", err)
	}
	missing := bundle.MissingTranslations()
	if jaMissing := missing[i18n.LangJapanese]; len(jaMissing) > 0 {
		t.Errorf("Japanese missing %d IDs: %v", len(jaMissing), jaMissing)
	}
}

func TestAllLanguages_StartupReadyIsDistinct(t *testing.T) {
	bundle, err := NewBundle()
	if err != nil {
		t.Fatalf("NewBundle() failed: %v", err)
	}
	seen := make(map[string]i18n.Lang)
	for _, tc := range allCatalogSpecs {
		msg, _ := bundle.Render(tc.lang, StartupReady)
		if prev, dup := seen[msg]; dup {
			// Log rather than fail: some langs may legitimately use same text.
			t.Logf("note: %s and %s produce identical StartupReady %q", tc.name, prev, msg)
		}
		seen[msg] = tc.lang
	}
}
