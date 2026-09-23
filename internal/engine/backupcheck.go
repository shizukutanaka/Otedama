// SPDX-License-Identifier: Apache-2.0
package engine

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"io"
	"math/big"
	"os"
	"sort"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/lightning"
)

// backupCheckPositions is how many mnemonic words the first-run backup
// check asks the operator to re-enter.
const backupCheckPositions = 3

// pickBackupPositions returns k distinct, ascending 1-based word
// positions in [1, n], drawn uniformly via crypto/rand. A nil or
// empty result is returned for degenerate n/k.
func pickBackupPositions(n, k int) []int {
	if n <= 0 || k <= 0 {
		return nil
	}
	if k > n {
		k = n
	}
	seen := make(map[int]struct{}, k)
	pos := make([]int, 0, k)
	for len(pos) < k {
		v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
		if err != nil {
			// crypto/rand failing means entropy is broken; return
			// what was drawn and let the prompt best-effort continue.
			break
		}
		p := int(v.Int64()) + 1
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		pos = append(pos, p)
	}
	sort.Ints(pos)
	return pos
}

// backupWordsMatch reports whether each answer equals the mnemonic word
// at the matching 1-based position, after trimming and case-folding.
// Each word compare runs through subtle.ConstantTimeCompare (session-263
// audit posture: mnemonic words are secret-derived); differing lengths
// short-circuit the compare the way hmac.Equal does — the length of the
// expected word is already public via the printed phrase.
func backupWordsMatch(m lightning.Mnemonic, positions []int, answers []string) bool {
	if len(positions) != len(answers) {
		return false
	}
	ok := true
	for i, p := range positions {
		if p < 1 || p > len(m) {
			return false
		}
		want := strings.ToLower(m[p-1])
		got := strings.ToLower(strings.TrimSpace(answers[i]))
		if len(got) != len(want) || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			ok = false
		}
	}
	return ok
}

// backupCheckRound runs one pass of the check: prompt for each position,
// read one line per position, and report whether all matched. The scanner
// is shared across rounds — a fresh one would buffer ahead and swallow
// the retry round's input. A read failure aborts the round early and is
// reported as inconclusive (false).
func backupCheckRound(w io.Writer, s *bufio.Scanner, m lightning.Mnemonic, positions []int) bool {
	answers := make([]string, 0, len(positions))
	for _, p := range positions {
		fmt.Fprintf(w, "  Word #%d: ", p)
		if !s.Scan() {
			fmt.Fprintln(w, "\n  (no input — backup check skipped)")
			return false
		}
		f := strings.Fields(s.Text())
		ans := ""
		if len(f) > 0 {
			ans = f[0]
		}
		answers = append(answers, ans)
	}
	return backupWordsMatch(m, positions, answers)
}

// interactiveInput reports whether r is a human-operated terminal, using
// the same stdlib-only os.ModeCharDevice check cmdRun applies to stdout
// for TUI auto-disable. A nil reader, a pipe/redirect, a service
// manager's stdin (/dev/null on systemd), or a non-file reader all
// return false — the check is strictly opt-in on real terminals so an
// unattended first run is never blocked waiting for input.
func interactiveInput(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// runBackupVerification asks the operator to prove they wrote the phrase
// down by re-entering pick(len(m), backupCheckPositions) randomly chosen
// words, retrying once with fresh positions after a miss. Returns true
// when the backup is verified, or when there is nothing to verify
// against; returns false only when the operator attempted and failed —
// failure warns loudly but never blocks startup, because the wallet is
// already created and mining may proceed while the operator re-checks
// their paper copy.
func runBackupVerification(w io.Writer, r io.Reader, m lightning.Mnemonic, pick func(n, k int) []int) bool {
	if w == nil || r == nil || len(m) == 0 {
		return true
	}
	fmt.Fprint(w, `
  Confirm your backup: re-enter the requested words. Words are
  case-insensitive; single-word answers, one per line.
`)
	s := bufio.NewScanner(r)
	positions := pick(len(m), backupCheckPositions)
	if backupCheckRound(w, s, m, positions) {
		fmt.Fprintln(w, "  Backup verified — the phrase you wrote down is correct.")
		return true
	}
	fmt.Fprint(w, `
  That did not match the printed phrase. Checking once more with
  different words — please copy carefully from the phrase above.
`)
	retry := pick(len(m), backupCheckPositions)
	if backupCheckRound(w, s, m, retry) {
		fmt.Fprintln(w, "  Backup verified — the phrase you wrote down is correct.")
		return true
	}
	fmt.Fprint(w, `
  WARNING: backup verification failed twice. Your written copy may
  contain a transcription error. Compare it against the printed phrase
  before trusting this wallet with funds — wallet.dat cannot re-derive
  the phrase later.
`)
	return false
}
