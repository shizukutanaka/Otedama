# Governance

This document describes how decisions are made in Otedama. It is
deliberately short, because Otedama is a small project and shouldn't
pretend to be more.

## Current model: BDFL with documented succession

Otedama is currently led by a single Benevolent Dictator For Life:
the lead listed in `MAINTAINERS.md`. The lead has final authority on
everything — design, code, releases, naming, scope.

This is the right model for a project of Otedama's size (one full-time-
equivalent's worth of attention spread across many evenings). It will
not necessarily be the right model forever; the "Phases" section
below sketches when and how it should change.

## Decision types

Different decisions follow different processes.

### 1. Code changes (PRs)

- **Trivial fixes** (typos, doc cleanups, dependency bumps): one
  approval from any committer or higher. Auto-mergeable if Renovate
  patch update.
- **Bug fixes**: one approval from any committer or higher.
- **Features**: open an issue first, get a thumbs-up from a
  maintainer that the direction makes sense, then PR. PR requires
  one approval from a maintainer.
- **Changes to `internal/lightning/` or `internal/stratum/noise*`**:
  CODEOWNERS-enforced; one maintainer approval required regardless
  of who the contributor is. Self-merge of these paths is
  configured to require a second reviewer.
- **Changes to public API** (CLI flags, config schema, HTTP
  endpoints, exit codes): require an ADR before merge. See "ADRs"
  below.

### 2. Releases

- **Patch (x.y.Z)**: any maintainer can tag, on their own initiative
  or in response to a bug fix.
- **Minor (x.Y.0)**: discussed in an issue at least 7 days before
  tagging. Any maintainer can tag once consensus is reached.
- **Major (X.0.0)**: requires an ADR documenting the breaking
  changes, a migration guide, and at least 30 days between proposal
  and tag.

The `[Unreleased]` section of `CHANGELOG.md` is the staging area;
maintainers update it with each merge.

### 3. Architecture decisions (ADRs)

`docs/adr/` contains the project's ADRs. New ADRs are proposed via
a PR to that directory.

- Status starts as `Proposed`.
- Discussion happens on the PR thread.
- Merge requires consensus from current maintainers; the lead has
  the tiebreaker.
- On merge, status becomes `Accepted`. ADRs are append-only — once
  accepted, they are not edited; if circumstances change, write a
  new ADR that supersedes the old one.

### 4. Code of Conduct enforcement

Reports go to the lead via the private vulnerability reporting flow.
The lead investigates and decides on warnings, temporary bans, or
permanent bans per the consequences ladder in `CODE_OF_CONDUCT.md`.

Appeals go to the second maintainer (when one exists) or, in the
single-maintainer phase, to the project's selected mediator (TBD; the
lead will identify one before the project crosses 100 contributors).

### 5. Scope

Otedama's scope is defined in `CLAUDE.md` under "Product definition".
Proposals to expand scope (new revenue streams, new protocols, new
target hardware classes) require a formal ADR and explicit majority
approval from active maintainers. The bar for scope expansion is
deliberately high; the project's longevity depends on doing one thing
well rather than many things adequately.

## Conflicts and tiebreaking

Disagreement among maintainers is resolved in this order:

1. Try to find consensus through discussion.
2. If consensus is impossible, the lead decides.
3. If the lead is the disagreeing party, the lead defers to a 2/3
   majority of the other maintainers, when at least 3 maintainers
   exist.
4. If no maintainer-level resolution is possible (very rare), the
   project status quo wins. Status quo means: do nothing, the
   default position.

Maintainers who feel strongly enough that they cannot accept the
outcome are free to fork. This is the open-source release valve and
the project respects it.

## Phases

Otedama's governance is expected to evolve through three phases.

### Phase 1: Solo (current, 0–18 months)

- One maintainer (BDFL).
- Decisions are fast and cheap because there is one decider.
- Bus factor = 1; mitigated by `MAINTAINERS.md` succession plan
  and Sigstore keyless signing (no long-lived secrets).
- Phase ends when a second co-maintainer is promoted.

### Phase 2: Multi-maintainer (target 18 months – 5 years)

- 2–5 maintainers.
- Lead retains tiebreaking authority.
- Decisions may take 1–2 weeks for non-trivial matters; consensus
  is preferred but not required.
- Bus factor ≥ 2.
- Phase ends if either: the project becomes large enough to
  warrant formal governance (Phase 3), or the project shrinks
  back to a single maintainer (Phase 1, less ideally).

### Phase 3: Formal governance (5+ years, only if needed)

- 5+ maintainers.
- Maintainership becomes a written role with explicit terms (e.g.
  rotating chair, voting rules, conflict-of-interest disclosures).
- The project may seek fiscal hosting (Open Source Collective,
  Linux Foundation, Software Freedom Conservancy) to handle
  donations, employment of contractors, or trademark enforcement.

Phase 3 is **not** an aspiration. Many projects do excellent work
indefinitely in Phase 2 (fzf, vim-plug, GoReleaser). Phase 3 is
appropriate only if Otedama's user base reaches a size where formal
process actually reduces friction rather than adding it.

## What this document is not

- **Not a commitment to any timeline.** All "phases" above describe
  what *could* happen, not what *must*. The project may stay in
  Phase 1 for its entire life.
- **Not a contract.** Maintainers are volunteers. They can leave at
  any time, with or without notice.
- **Not a substitute for trust.** Documented governance helps
  resolve specific disputes, but most decisions are made by
  reasonable people communicating in good faith. Otedama assumes
  this baseline; if it ever erodes, no document will save us.

## Amendments

This document may be amended by:

- The lead, in Phase 1.
- Maintainer consensus, in Phase 2.
- The process defined in the formal governance document, in Phase 3.

Amendments are tracked in this file's Git history; there is no
separate amendment log.
