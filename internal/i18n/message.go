// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package i18n provides internationalization for Otedama.
//
// # Design Rationale
//
// Every major competing mining software is effectively English-only.
// Braiins OS+, CGMiner, BFGMiner, Awesome Miner, and Hive OS ship with
// English UI and English error messages. Non-English speakers must either
// learn English technical vocabulary or rely on machine translation of
// error messages they receive at runtime. This is a structural gap in
// the market, not an oversight.
//
// Otedama addresses this gap by designing internationalization into the
// foundation rather than bolting it on later. All user-facing strings
// flow through this package. The ten priority languages (English,
// Japanese, Chinese, Korean, Spanish, French, German, Portuguese,
// Russian, Arabic) receive human-reviewed translations; other languages
// are supplied by machine translation as a best-effort fallback.
//
// # Architecture
//
// Messages are identified by an opaque ID type, not by raw strings. This
// prevents accidental string interpolation bugs (no format-specifier
// mismatches between languages) and allows the linter to detect unused
// or missing message IDs. A Catalog maps (language tag, message ID) to
// the rendered string. A Bundle holds multiple Catalogs and selects
// among them based on the requested language, with automatic fallback
// to English for missing translations.
//
// # Threading
//
// Catalog and Bundle are immutable after construction. They are safe for
// concurrent use by any number of goroutines without locking. This
// matters because the i18n bundle is typically consulted on every log
// line, every API response, and every CLI prompt; a global lock would
// become a contention bottleneck.
package i18n

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"text/template"
)

// ID is an opaque message identifier.
//
// IDs are strings by convention but typed distinctly to prevent
// accidentally passing a raw user-facing string where a message ID is
// expected. The recommended format is "area.subarea.message_name", for
// example "startup.wallet_created" or "error.pool_unreachable".
type ID string

// String returns the underlying string representation of the ID.
//
// This is primarily useful for logging when a translation is missing
// and the raw ID must be surfaced as a diagnostic fallback.
func (id ID) String() string {
	return string(id)
}

// Valid reports whether id is a syntactically valid message identifier.
//
// A valid ID is non-empty, uses only lowercase ASCII letters, digits,
// and the '.' and '_' characters, and does not start or end with '.'.
// This constraint keeps IDs mechanically checkable by the linter.
func (id ID) Valid() bool {
	s := string(id)
	if s == "" {
		return false
	}
	if s[0] == '.' || s[len(s)-1] == '.' {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '.' || r == '_':
		default:
			return false
		}
	}
	return true
}

// Lang is an IETF BCP 47 language tag.
//
// Otedama does not use golang.org/x/text/language's Tag type directly;
// that type has subtle matching semantics (e.g., "en-GB" matching "en")
// that we prefer to keep under our own control for testability. Lang
// is just a string with a validation method.
type Lang string

// Predefined language constants for the ten priority languages.
// Additional languages are accepted as Lang values but are not required
// to have human-reviewed translations.
const (
	LangEnglish    Lang = "en"
	LangJapanese   Lang = "ja"
	LangChinese    Lang = "zh"
	LangKorean     Lang = "ko"
	LangSpanish    Lang = "es"
	LangFrench     Lang = "fr"
	LangGerman     Lang = "de"
	LangPortuguese Lang = "pt"
	LangRussian    Lang = "ru"
	LangArabic     Lang = "ar"
)

// PriorityLanguages returns the ten priority languages in a stable order.
//
// These are the languages for which Otedama commits to providing
// human-reviewed translations. All other languages are best-effort.
func PriorityLanguages() []Lang {
	return []Lang{
		LangEnglish, LangJapanese, LangChinese, LangKorean, LangSpanish,
		LangFrench, LangGerman, LangPortuguese, LangRussian, LangArabic,
	}
}

// Valid reports whether l looks like a well-formed BCP 47 tag.
//
// This is a lightweight check (length and character class), not a full
// parse. The full BCP 47 grammar is complex; for Otedama's purposes,
// rejecting obvious typos at configuration load time is sufficient.
func (l Lang) Valid() bool {
	s := string(l)
	if len(s) < 2 || len(s) > 35 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-':
		default:
			return false
		}
	}
	return true
}

// Base returns the primary language subtag, e.g. "ja" from "ja-JP".
//
// This is used during fallback: if the requested language "ja-JP" is
// not present in the catalog, Base("ja-JP") = "ja" may be.
func (l Lang) Base() Lang {
	s := string(l)
	if idx := strings.IndexByte(s, '-'); idx >= 0 {
		return Lang(s[:idx])
	}
	return l
}

// Catalog maps message IDs to their rendered strings for a single language.
//
// Catalogs are immutable after construction (see NewCatalog). This
// allows them to be shared across goroutines without locking.
type Catalog struct {
	lang     Lang
	messages map[ID]string
}

// NewCatalog constructs a Catalog for the given language from a map of
// ID→message.
//
// NewCatalog returns an error if lang is not a valid Lang, if messages
// is nil, or if any ID in the map is invalid. It takes a copy of
// messages so that subsequent modifications to the caller's map do not
// affect the Catalog.
func NewCatalog(lang Lang, messages map[ID]string) (*Catalog, error) {
	if !lang.Valid() {
		return nil, fmt.Errorf("i18n: invalid language tag %q", lang)
	}
	if messages == nil {
		return nil, errors.New("i18n: messages map must not be nil")
	}

	copied := make(map[ID]string, len(messages))
	for id, msg := range messages {
		if !id.Valid() {
			return nil, fmt.Errorf("i18n: invalid message ID %q in catalog for %q", id, lang)
		}
		copied[id] = msg
	}

	return &Catalog{lang: lang, messages: copied}, nil
}

// Lang returns the language of this catalog.
func (c *Catalog) Lang() Lang {
	return c.lang
}

// Lookup returns the rendered message for the given ID, or the empty
// string and false if the ID is not present in this catalog.
//
// Callers should almost always use Bundle.Render rather than calling
// Lookup directly, because Render handles fallback to English. Lookup
// is exposed primarily for tests and linting tools.
func (c *Catalog) Lookup(id ID) (string, bool) {
	msg, ok := c.messages[id]
	return msg, ok
}

// IDs returns the message IDs present in this catalog, sorted
// lexicographically.
//
// The returned slice is a new allocation; callers may modify it.
// Sorted output makes diffing two catalogs (e.g., to find missing
// translations) straightforward.
func (c *Catalog) IDs() []ID {
	ids := make([]ID, 0, len(c.messages))
	for id := range c.messages {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// Bundle holds multiple Catalogs and selects among them based on the
// requested language.
//
// Bundle is immutable after construction. The English catalog is
// mandatory and serves as the fallback for any missing translation in
// other languages.
type Bundle struct {
	english  *Catalog
	catalogs map[Lang]*Catalog
}

// NewBundle constructs a Bundle from a mandatory English catalog and
// zero or more additional-language catalogs.
//
// The English catalog is required because it is Otedama's fallback
// language. If a user's preferred language is missing a translation,
// the English version is rendered instead. This guarantees that every
// message can always be rendered in at least one language.
//
// NewBundle returns an error if english is nil, if english.Lang() is not
// LangEnglish, or if any other catalog has the same Lang as an earlier
// one (duplicate language).
func NewBundle(english *Catalog, others ...*Catalog) (*Bundle, error) {
	if english == nil {
		return nil, errors.New("i18n: English catalog is required")
	}
	if english.Lang() != LangEnglish {
		return nil, fmt.Errorf("i18n: expected English catalog, got %q", english.Lang())
	}

	catalogs := map[Lang]*Catalog{LangEnglish: english}
	for _, c := range others {
		if c == nil {
			return nil, errors.New("i18n: additional catalog must not be nil")
		}
		if _, exists := catalogs[c.Lang()]; exists {
			return nil, fmt.Errorf("i18n: duplicate catalog for language %q", c.Lang())
		}
		catalogs[c.Lang()] = c
	}

	return &Bundle{english: english, catalogs: catalogs}, nil
}

// Render returns the message for the given ID in the requested language,
// falling back to the base language tag and then to English.
//
// For example, a request for Lang("ja-JP") on a bundle containing only
// Lang("ja") and English will match "ja" via the base-tag fallback.
// A request for Lang("fi") on a bundle with no Finnish catalog falls
// back to English.
//
// If the ID is missing from every consulted catalog (including English),
// Render returns a placeholder string of the form "!{id}!" and a non-nil
// error. The placeholder is chosen to be visually conspicuous in logs so
// that missing translations are easy to spot in production.
func (b *Bundle) Render(lang Lang, id ID) (string, error) {
	// Try exact language match.
	if c, ok := b.catalogs[lang]; ok {
		if msg, ok := c.Lookup(id); ok {
			return msg, nil
		}
	}

	// Try base language (e.g., "ja" for "ja-JP").
	if base := lang.Base(); base != lang {
		if c, ok := b.catalogs[base]; ok {
			if msg, ok := c.Lookup(id); ok {
				return msg, nil
			}
		}
	}

	// Fall back to English.
	if msg, ok := b.english.Lookup(id); ok {
		return msg, nil
	}

	// The ID is missing entirely. Surface this to the caller as an error
	// while providing a placeholder so that UI rendering can proceed.
	return "!" + string(id) + "!", fmt.Errorf("i18n: message %q not found in any catalog", id)
}

// RenderWith renders a message and substitutes template variables.
//
// data maps placeholder names (without braces) to values. For example:
//
//	bundle.RenderWith(lang, StatusMining, map[string]any{
//	    "devices":  "3",
//	    "hashrate": "4.20 MH/s",
//	})
//
// renders "Mining on 3 device(s). Current hashrate: 4.20 MH/s." in English.
//
// If the template execution fails (for example, a placeholder in the
// message refers to a key not present in data), the raw template string
// is returned along with the execution error. This graceful degradation
// ensures UI rendering is never completely broken by a missing variable.
func (b *Bundle) RenderWith(lang Lang, id ID, data map[string]any) (string, error) {
	raw, err := b.Render(lang, id)
	if err != nil {
		return raw, err
	}
	if data == nil || !strings.Contains(raw, "{{") {
		return raw, nil
	}
	tmpl, parseErr := template.New("").Parse(raw)
	if parseErr != nil {
		return raw, fmt.Errorf("i18n: parse template for %q: %w", id, parseErr)
	}
	var buf strings.Builder
	if execErr := tmpl.Execute(&buf, data); execErr != nil {
		return raw, fmt.Errorf("i18n: execute template for %q: %w", id, execErr)
	}
	return buf.String(), nil
}

// MissingTranslations returns, for each non-English language in this
// bundle, the set of message IDs that are present in English but missing
// in that language.
//
// This function is used by the CI translation-completeness check to
// ensure that the ten priority languages keep pace with changes to the
// English catalog. A non-empty result indicates that human translators
// need to supply the missing strings.
//
// The returned map has one entry per non-English language; the value is
// sorted for stable output.
func (b *Bundle) MissingTranslations() map[Lang][]ID {
	result := make(map[Lang][]ID)

	englishIDs := b.english.IDs()

	for lang, c := range b.catalogs {
		if lang == LangEnglish {
			continue
		}
		var missing []ID
		for _, id := range englishIDs {
			if _, ok := c.Lookup(id); !ok {
				missing = append(missing, id)
			}
		}
		// Omit languages with no missing translations; the caller can
		// treat absence from the map as "complete".
		if len(missing) > 0 {
			sort.Slice(missing, func(i, j int) bool { return missing[i] < missing[j] })
			result[lang] = missing
		}
	}

	return result
}

// Languages returns the languages available in this bundle, sorted so
// that the English fallback is first and others follow alphabetically.
func (b *Bundle) Languages() []Lang {
	result := make([]Lang, 0, len(b.catalogs))
	for lang := range b.catalogs {
		if lang != LangEnglish {
			result = append(result, lang)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return append([]Lang{LangEnglish}, result...)
}
