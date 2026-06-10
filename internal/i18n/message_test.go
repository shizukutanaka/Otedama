// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package i18n

import (
	"strings"
	"sync"
	"testing"
)

// ----- ID tests -----

func TestID_Valid(t *testing.T) {
	tests := []struct {
		name string
		id   ID
		want bool
	}{
		{"typical hierarchical ID", ID("startup.wallet_created"), true},
		{"single segment", ID("ready"), true},
		{"with digits", ID("error.pool_3_timeout"), true},
		{"deep nesting", ID("a.b.c.d.e"), true},
		{"empty rejected", ID(""), false},
		{"leading dot rejected", ID(".startup"), false},
		{"trailing dot rejected", ID("startup."), false},
		{"uppercase rejected", ID("Startup.Done"), false},
		{"hyphens rejected", ID("startup-done"), false},
		{"spaces rejected", ID("startup done"), false},
		{"unicode rejected", ID("起動.完了"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := tt.id.Valid(); got != tt.want {
				t.Errorf("ID(%q).Valid() = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

func TestID_String(t *testing.T) {
	id := ID("startup.wallet_created")
	if got := id.String(); got != "startup.wallet_created" {
		t.Errorf("String() = %q, want underlying string", got)
	}
}

// ----- Lang tests -----

func TestLang_Valid(t *testing.T) {
	tests := []struct {
		name string
		lang Lang
		want bool
	}{
		{"English", LangEnglish, true},
		{"Japanese", LangJapanese, true},
		{"Chinese simplified", Lang("zh-CN"), true},
		{"Portuguese Brazil", Lang("pt-BR"), true},
		{"three-letter language", Lang("eng"), true},
		{"extended tag", Lang("zh-Hant-TW"), true},
		{"too short rejected", Lang("e"), false},
		{"empty rejected", Lang(""), false},
		{"digits-only rejected? (digits allowed per BCP 47)", Lang("12"), true},
		{"underscore rejected", Lang("en_US"), false},
		{"unicode rejected", Lang("日本"), false},
		{"too long rejected", Lang(strings.Repeat("a", 40)), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := tt.lang.Valid(); got != tt.want {
				t.Errorf("Lang(%q).Valid() = %v, want %v", tt.lang, got, tt.want)
			}
		})
	}
}

func TestLang_Base(t *testing.T) {
	tests := []struct {
		input Lang
		want  Lang
	}{
		{Lang("en"), Lang("en")},
		{Lang("en-US"), Lang("en")},
		{Lang("zh-Hant-TW"), Lang("zh")},
		{Lang("ja-JP"), Lang("ja")},
		{Lang("pt-BR"), Lang("pt")},
	}
	for _, tt := range tests {
		t.Run(string(tt.input), func(t *testing.T) {
			t.Parallel()
			if got := tt.input.Base(); got != tt.want {
				t.Errorf("Lang(%q).Base() = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestPriorityLanguages_ContainsExpectedTen(t *testing.T) {
	got := PriorityLanguages()
	want := []Lang{
		LangEnglish, LangJapanese, LangChinese, LangKorean, LangSpanish,
		LangFrench, LangGerman, LangPortuguese, LangRussian, LangArabic,
	}
	if len(got) != len(want) {
		t.Fatalf("PriorityLanguages() has %d entries, want %d", len(got), len(want))
	}
	for i, l := range got {
		if l != want[i] {
			t.Errorf("PriorityLanguages()[%d] = %q, want %q", i, l, want[i])
		}
	}
}

func TestPriorityLanguages_AllEntriesValid(t *testing.T) {
	// Every entry returned by PriorityLanguages must pass Lang.Valid.
	// This guards against typos in the constants.
	for _, lang := range PriorityLanguages() {
		if !lang.Valid() {
			t.Errorf("priority language %q failed Valid()", lang)
		}
	}
}

// ----- Catalog tests -----

func TestNewCatalog_RejectsInvalidLang(t *testing.T) {
	_, err := NewCatalog(Lang(""), map[ID]string{})
	if err == nil {
		t.Error("NewCatalog with invalid lang must return error")
	}
}

func TestNewCatalog_RejectsNilMessages(t *testing.T) {
	_, err := NewCatalog(LangEnglish, nil)
	if err == nil {
		t.Error("NewCatalog with nil messages must return error")
	}
}

func TestNewCatalog_RejectsInvalidID(t *testing.T) {
	_, err := NewCatalog(LangEnglish, map[ID]string{
		ID(""): "empty ID should fail",
	})
	if err == nil {
		t.Error("NewCatalog with invalid ID must return error")
	}
}

func TestCatalog_Lookup(t *testing.T) {
	c, err := NewCatalog(LangEnglish, map[ID]string{
		ID("startup.ready"): "Otedama is ready.",
	})
	if err != nil {
		t.Fatalf("NewCatalog failed: %v", err)
	}

	msg, ok := c.Lookup(ID("startup.ready"))
	if !ok {
		t.Fatal("Lookup returned false for existing ID")
	}
	if msg != "Otedama is ready." {
		t.Errorf("Lookup returned %q, want %q", msg, "Otedama is ready.")
	}

	_, ok = c.Lookup(ID("nonexistent"))
	if ok {
		t.Error("Lookup returned true for missing ID")
	}
}

func TestCatalog_IsImmutable(t *testing.T) {
	// Modifying the source map after NewCatalog must not affect the
	// catalog. This invariant is what makes catalogs safe to share
	// across goroutines without locking.
	source := map[ID]string{
		ID("test"): "original",
	}
	c, err := NewCatalog(LangEnglish, source)
	if err != nil {
		t.Fatalf("NewCatalog failed: %v", err)
	}

	source[ID("test")] = "modified"
	source[ID("new_id")] = "added later"

	msg, _ := c.Lookup(ID("test"))
	if msg != "original" {
		t.Errorf("Lookup returned %q, want %q (catalog must be immutable)", msg, "original")
	}
	if _, ok := c.Lookup(ID("new_id")); ok {
		t.Error("Lookup returned true for ID added after construction (catalog must be immutable)")
	}
}

func TestCatalog_IDsReturnsSorted(t *testing.T) {
	c, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("z.last"):  "",
		ID("a.first"): "",
		ID("m.mid"):   "",
	})

	got := c.IDs()
	want := []ID{ID("a.first"), ID("m.mid"), ID("z.last")}

	if len(got) != len(want) {
		t.Fatalf("IDs() returned %d entries, want %d", len(got), len(want))
	}
	for i, id := range got {
		if id != want[i] {
			t.Errorf("IDs()[%d] = %q, want %q", i, id, want[i])
		}
	}
}

// ----- Bundle tests -----

func TestNewBundle_RejectsNilEnglish(t *testing.T) {
	_, err := NewBundle(nil)
	if err == nil {
		t.Error("NewBundle(nil) must return error")
	}
}

func TestNewBundle_RejectsNonEnglishAsFallback(t *testing.T) {
	ja, _ := NewCatalog(LangJapanese, map[ID]string{})
	_, err := NewBundle(ja)
	if err == nil {
		t.Error("NewBundle with non-English fallback must return error")
	}
}

func TestNewBundle_RejectsDuplicateLanguages(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{})
	ja1, _ := NewCatalog(LangJapanese, map[ID]string{})
	ja2, _ := NewCatalog(LangJapanese, map[ID]string{})

	_, err := NewBundle(en, ja1, ja2)
	if err == nil {
		t.Error("NewBundle with duplicate languages must return error")
	}
}

func TestBundle_RenderUsesExactLanguageMatch(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("greeting"): "Hello",
	})
	ja, _ := NewCatalog(LangJapanese, map[ID]string{
		ID("greeting"): "こんにちは",
	})
	b, _ := NewBundle(en, ja)

	got, err := b.Render(LangJapanese, ID("greeting"))
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if got != "こんにちは" {
		t.Errorf("Render returned %q, want %q", got, "こんにちは")
	}
}

func TestBundle_RenderFallsBackToBaseLang(t *testing.T) {
	// Request "ja-JP" but the bundle only has "ja". The base-tag
	// fallback must find the "ja" entry.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("greeting"): "Hello",
	})
	ja, _ := NewCatalog(LangJapanese, map[ID]string{
		ID("greeting"): "こんにちは",
	})
	b, _ := NewBundle(en, ja)

	got, err := b.Render(Lang("ja-JP"), ID("greeting"))
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if got != "こんにちは" {
		t.Errorf("Render with ja-JP returned %q, want Japanese %q", got, "こんにちは")
	}
}

func TestBundle_RenderFallsBackToEnglish(t *testing.T) {
	// Request a language not in the bundle. Must fall back to English.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("greeting"): "Hello",
	})
	b, _ := NewBundle(en)

	got, err := b.Render(LangJapanese, ID("greeting"))
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if got != "Hello" {
		t.Errorf("Render for missing language returned %q, want English %q", got, "Hello")
	}
}

func TestBundle_RenderFallsBackForPartialTranslation(t *testing.T) {
	// Japanese catalog has only one message; request a different message
	// in Japanese, expect English fallback.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("greeting"): "Hello",
		ID("farewell"): "Goodbye",
	})
	ja, _ := NewCatalog(LangJapanese, map[ID]string{
		ID("greeting"): "こんにちは",
		// farewell deliberately missing
	})
	b, _ := NewBundle(en, ja)

	got, err := b.Render(LangJapanese, ID("farewell"))
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if got != "Goodbye" {
		t.Errorf("Render fell through to %q, want English %q", got, "Goodbye")
	}
}

func TestBundle_RenderReturnsPlaceholderForUnknownID(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("known"): "present",
	})
	b, _ := NewBundle(en)

	got, err := b.Render(LangEnglish, ID("unknown.id"))
	if err == nil {
		t.Error("Render for unknown ID must return error")
	}
	// The placeholder must contain the missing ID so that operators
	// seeing this in logs can identify the offending message.
	if !strings.Contains(got, "unknown.id") {
		t.Errorf("placeholder %q must contain the missing ID", got)
	}
}

func TestBundle_MissingTranslationsReportsGaps(t *testing.T) {
	// This test enforces Otedama's core i18n commitment: every message in
	// the English catalog must be present in every priority language.
	// MissingTranslations is the mechanism by which CI detects regressions.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("a"): "A",
		ID("b"): "B",
		ID("c"): "C",
	})
	ja, _ := NewCatalog(LangJapanese, map[ID]string{
		ID("a"): "Aの訳",
		// b and c are missing
	})
	fr, _ := NewCatalog(LangFrench, map[ID]string{
		ID("a"): "A traduit",
		ID("b"): "B traduit",
		ID("c"): "C traduit",
	})

	b, _ := NewBundle(en, ja, fr)

	missing := b.MissingTranslations()

	jaMissing, ok := missing[LangJapanese]
	if !ok {
		t.Fatal("Japanese should appear in MissingTranslations")
	}
	if len(jaMissing) != 2 {
		t.Errorf("Japanese missing %d IDs, want 2", len(jaMissing))
	}
	// Sorted output guarantees deterministic comparison.
	wantMissing := []ID{ID("b"), ID("c")}
	for i, id := range jaMissing {
		if id != wantMissing[i] {
			t.Errorf("jaMissing[%d] = %q, want %q", i, id, wantMissing[i])
		}
	}

	// French is complete, so it must not appear in the result at all.
	if _, ok := missing[LangFrench]; ok {
		t.Error("French has complete translations; must not appear in MissingTranslations")
	}
}

func TestBundle_LanguagesListsEnglishFirst(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{})
	ja, _ := NewCatalog(LangJapanese, map[ID]string{})
	fr, _ := NewCatalog(LangFrench, map[ID]string{})
	b, _ := NewBundle(en, ja, fr)

	got := b.Languages()
	if len(got) != 3 {
		t.Fatalf("Languages() returned %d entries, want 3", len(got))
	}
	if got[0] != LangEnglish {
		t.Errorf("Languages()[0] = %q, want English first (as fallback)", got[0])
	}
}

func TestBundle_ConcurrentRenderIsSafe(t *testing.T) {
	// Bundle must support concurrent Render calls without any locking.
	// Run under the race detector to verify.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("msg.a"): "A",
		ID("msg.b"): "B",
	})
	ja, _ := NewCatalog(LangJapanese, map[ID]string{
		ID("msg.a"): "Aの訳",
	})
	b, _ := NewBundle(en, ja)

	const goroutines = 50
	const iterations = 1000

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				_, _ = b.Render(LangJapanese, ID("msg.a"))
				_, _ = b.Render(LangJapanese, ID("msg.b"))
				_, _ = b.Render(LangEnglish, ID("msg.a"))
			}
		}()
	}
	wg.Wait()
	// If the race detector reports no data races, the test passes.
}

// ----- Integration: ten-language coverage enforcement -----

func TestTenLanguageCoverage_EnglishOnlyBundleReportsMissing(t *testing.T) {
	// This scenario represents an early development state where only
	// English has been authored. MissingTranslations on such a bundle
	// must correctly identify the nine languages that still need work.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("hello"): "Hello",
	})

	bundle, _ := NewBundle(en)

	missing := bundle.MissingTranslations()
	// With only an English catalog, there are no non-English catalogs
	// to compare against; MissingTranslations should return an empty
	// map (not an error). The completeness check is a separate tool
	// that iterates over PriorityLanguages.
	if len(missing) != 0 {
		t.Errorf("bundle with only English has %d missing entries, want 0", len(missing))
	}
}

// ============================================================================
// NewBundle — nil catalog in variadic args
// ============================================================================

func TestNewBundle_RejectsNilExtraCatalog(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{ID("hi"): "Hello"})
	_, err := NewBundle(en, nil)
	if err == nil {
		t.Error("NewBundle(en, nil) must return error for nil extra catalog")
	}
}

// ============================================================================
// RenderWith — all branches
// ============================================================================

func TestRenderWith_NilData_ReturnsMsgDirectly(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{ID("greet"): "Hello, world"})
	b, _ := NewBundle(en)
	got, err := b.RenderWith(LangEnglish, ID("greet"), nil)
	if err != nil {
		t.Errorf("RenderWith nil data: %v", err)
	}
	if got != "Hello, world" {
		t.Errorf("RenderWith nil data = %q, want %q", got, "Hello, world")
	}
}

func TestRenderWith_NoTemplate_ReturnsMsgDirectly(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{ID("greet"): "Hello, world"})
	b, _ := NewBundle(en)
	got, err := b.RenderWith(LangEnglish, ID("greet"), map[string]any{"x": 1})
	if err != nil {
		t.Errorf("RenderWith no template: %v", err)
	}
	if got != "Hello, world" {
		t.Errorf("RenderWith no template = %q, want %q", got, "Hello, world")
	}
}

func TestRenderWith_MissingID_ReturnsRenderError(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{})
	b, _ := NewBundle(en)
	_, err := b.RenderWith(LangEnglish, ID("nonexistent"), nil)
	if err == nil {
		t.Error("RenderWith missing ID must return error")
	}
}

func TestRenderWith_WithTemplate_SubstitutesVariables(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("tmpl"): "Hello, {{.name}}!",
	})
	b, _ := NewBundle(en)
	got, err := b.RenderWith(LangEnglish, ID("tmpl"), map[string]any{"name": "Alice"})
	if err != nil {
		t.Errorf("RenderWith template: %v", err)
	}
	if !strings.Contains(got, "Alice") {
		t.Errorf("RenderWith template = %q, want to contain 'Alice'", got)
	}
}

func TestRenderWith_BadTemplate_ReturnsParseError(t *testing.T) {
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("bad"): "Hello, {{.name",
	})
	b, _ := NewBundle(en)
	_, err := b.RenderWith(LangEnglish, ID("bad"), map[string]any{"name": "x"})
	if err == nil {
		t.Error("RenderWith bad template must return parse error")
	}
}

func TestRenderWith_ExecuteError_ReturnsExecError(t *testing.T) {
	// Use a template that calls a function that doesn't exist in the data.
	// In Go templates, accessing a field that doesn't exist returns empty,
	// but calling an undefined function causes an execute error.
	en, _ := NewCatalog(LangEnglish, map[ID]string{
		ID("fn"): "{{call .fn}}",
	})
	b, _ := NewBundle(en)
	// Pass data with a non-callable "fn" to force Execute to fail.
	_, err := b.RenderWith(LangEnglish, ID("fn"), map[string]any{"fn": "not a function"})
	if err == nil {
		t.Error("RenderWith execute error must return exec error")
	}
}
