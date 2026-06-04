// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package messages

import "github.com/shizukutanaka/Otedama/internal/i18n"

// NewBundle builds an i18n.Bundle containing all built-in language
// catalogs. The English catalog is always present; catalogs that fail
// to construct (should never happen with hand-written maps, but possible
// if an empty string was accidentally introduced) are silently skipped
// so that a single translation bug does not prevent the application from
// starting.
//
// Callers that need to verify translation completeness should call
// bundle.MissingTranslations() after construction.
func NewBundle() (*i18n.Bundle, error) {
	en, err := English()
	if err != nil {
		return nil, err
	}

	type catalogFn func() (*i18n.Catalog, error)
	others := []catalogFn{
		Japanese, Chinese, Korean,
		Spanish, French, German, Portuguese,
		Russian, Arabic,
	}

	var built []*i18n.Catalog
	for _, fn := range others {
		c, err := fn()
		if err != nil {
			// Log-worthy but non-fatal: English fallback covers it.
			continue
		}
		built = append(built, c)
	}

	return i18n.NewBundle(en, built...)
}

// DetectLang maps a raw BCP-47 tag string (from --language flag or
// OS locale) to the nearest supported i18n.Lang. Returns LangEnglish
// if no match is found.
func DetectLang(tag string) i18n.Lang {
	if tag == "" {
		return i18n.LangEnglish
	}
	// Exact match first.
	candidate := i18n.Lang(tag)
	for _, l := range i18n.PriorityLanguages() {
		if l == candidate {
			return l
		}
	}
	// Base language match (e.g., "ja-JP" → "ja").
	for _, l := range i18n.PriorityLanguages() {
		if string(l) == string(candidate.Base()) {
			return l
		}
	}
	return i18n.LangEnglish
}
