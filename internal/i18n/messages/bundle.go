// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

// Package messages holds Otedama's built-in message catalogs.
//
// # What "10 languages" covers, exactly (stated session 265)
//
// The catalogs span ten languages (en, ja, zh, ko, es, fr, de, pt, ru, ar)
// and fifteen message IDs — the startup, error, and status lines that
// engine startup renders through cmd/otedama's logln (run.go). That is the
// whole surface: the TUI dashboard, `otedama doctor`'s reports, the
// `wallet` subcommands, and the structured logs are English-only today.
// "Supports 10 languages" is true of this catalog and implies nothing
// beyond it.
//
// What the tests enforce is likewise exactly this much: every language
// covers every English ID, placeholders match, templates parse, and no
// message is empty (messages_test.go). Whether a translation reads well to
// a native speaker — CLAUDE.md's "human-reviewed" bar — is not something a
// test in this repository can establish, so no test claims to.
//
// Widening the surface (doctor, wallet, TUI) means adding IDs here and
// routing those outputs through the bundle; adding a language means one
// more catalog function and the completeness tests take care of the rest.
// Machine-filling either direction would dilute real translations, which
// is the same defect as coverage padding and is treated the same way.
package messages

import (
	"strings"

	"github.com/shizukutanaka/Otedama/internal/i18n"
)

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

// DetectLang maps a raw BCP-47 tag string (from the --language flag,
// OTEDAMA_LANGUAGE env, or config file) to the nearest supported
// i18n.Lang. Returns LangEnglish if no match is found. To resolve the
// language from the POSIX locale environment instead, use
// DetectLangFromEnv.
//
// BCP-47 tags are case-insensitive (RFC 5646 §2.1.1), so the input is
// lower-cased before matching: "JA", "ja-JP", and "ja" all resolve to
// Japanese. The supported languages (PriorityLanguages) are all stored
// in canonical lower case.
func DetectLang(tag string) i18n.Lang {
	if tag == "" {
		return i18n.LangEnglish
	}
	candidate := i18n.Lang(strings.ToLower(tag))
	// Exact match first.
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

// localeEnvVars lists the POSIX environment variables that select the UI
// language, in precedence order: POSIX specifies that LC_ALL overrides
// LC_MESSAGES, which overrides LANG.
var localeEnvVars = []string{"LC_ALL", "LC_MESSAGES", "LANG"}

// DetectLangFromEnv resolves the UI language from the POSIX locale
// environment variables (LC_ALL, LC_MESSAGES, LANG, in that precedence),
// returning the matching supported language or LangEnglish when none is set
// or the neutral "C"/"POSIX" locale is requested.
//
// getenv is the environment lookup (os.Getenv in production); it is a
// parameter so the resolution is unit-testable without mutating the process
// environment. Callers use this only when no explicit language has been
// configured via flag, env (OTEDAMA_LANGUAGE), or config file.
func DetectLangFromEnv(getenv func(string) string) i18n.Lang {
	for _, key := range localeEnvVars {
		v := getenv(key)
		if v == "" {
			continue
		}
		tag := normalizePOSIXLocale(v)
		if tag == "" {
			// "C" / "POSIX": the neutral locale requests no localization.
			return i18n.LangEnglish
		}
		return DetectLang(tag)
	}
	return i18n.LangEnglish
}

// normalizePOSIXLocale converts a POSIX locale string such as
// "ja_JP.UTF-8@modifier" into a BCP-47 tag "ja-JP" by stripping the codeset
// (after '.') and modifier (after '@') and converting the '_' territory
// separator to '-'. The neutral locales "C" and "POSIX" (the request for no
// localization) return the empty string.
func normalizePOSIXLocale(s string) string {
	if i := strings.IndexAny(s, ".@"); i >= 0 {
		s = s[:i]
	}
	if s == "" || s == "C" || s == "POSIX" {
		return ""
	}
	return strings.ReplaceAll(s, "_", "-")
}
