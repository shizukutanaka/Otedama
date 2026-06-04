# Maintainers

Otedama is currently maintained by one person. This document exists so
that the project can keep running even if that person becomes
unavailable — through illness, life change, or simple burnout.

The 2024 Tidelift maintainer survey found that 60% of open-source
maintainers have considered quitting and 44% report active burnout.
Several well-funded projects (Kubernetes Ingress NGINX, External
Secrets Operator) have been declared end-of-life in 2025–2026 because
their maintainer base collapsed faster than recovery was possible.
Otedama plans to outlast that pattern by writing down the recovery
path before it is needed.

## Current maintainer

| Role | GitHub | Active since | Time zone | Time budget |
|------|--------|--------------|-----------|-------------|
| Lead | [@shizukutanaka](https://github.com/shizukutanaka) | 2026-04 | Asia/Tokyo (JST, UTC+9) | ~10 h/week, no SLA |

The lead maintainer is responsible for:

- Approving and merging PRs into `main`.
- Tagging releases.
- Holding the release signing key (see "Signing keys" below).
- Triaging security advisories.
- Setting roadmap direction.

There is **no** corporate sponsor, no foundation, and no income from
the project at present. The lead works on Otedama out of interest,
not obligation. Users should plan accordingly: response times of
1–14 days on issues are normal, and there is no commitment to fix
any specific bug on any specific timeline.

## Becoming a co-maintainer

Otedama uses a three-step ladder. Each step is reversible — anyone
can step back from a role at any time without explanation.

### 1. Triager

What it means: triage rights on issues and PRs. Can label, assign
milestones, close as duplicate / not-planned, request changes on PRs.
Cannot merge.

How to get there:

- 3 merged PRs over a 6-month window.
- Demonstrated familiarity with `CLAUDE.md`, `docs/adr/`, and the
  test suite.
- A short conversation (issue or DM) confirming interest.

The lead grants triager rights via GitHub repo settings.

### 2. Committer

What it means: merge rights on `main` for non-security-critical
paths. Can approve PRs, merge after CI passes. Still cannot tag a
release or sign artifacts.

How to get there (additive to Triager):

- 6 more months of active triage and reviews.
- One feature shipped end-to-end (issue → PR → release notes).
- Demonstrated good judgment on at least one contentious issue.

Path-restricted via CODEOWNERS: committers cannot land changes to
`internal/lightning/` or `internal/stratum/noise*` without the lead's
review. This restriction is the same one the lead currently lives
under for these paths (self-merge requires a second approval, even
from oneself, by repository settings).

### 3. Maintainer

What it means: full repository access including release signing.
Can tag releases. Holds a copy of the signing key.

How to get there (additive to Committer):

- 12 more months as committer.
- Private 1:1 with the lead (video or async written) covering: who
  the candidate is, why they want this, what their availability
  realistically is, and what happens if they step back.
- The candidate signs the DCO and any required NDAs for key custody
  (see "Signing keys").
- The lead and any existing maintainers achieve consensus.

A new maintainer is added to this file in the same commit that
grants them repo permissions. **Maintainership is not the goal.**
Most contributors will be most productive at the Triager or Committer
level; nobody is pressured to ascend.

## Signing keys

Two pieces of key material exist for Otedama releases:

1. **Cosign keyless signing** (preferred). Per-release ephemeral keys
   issued by Sigstore via GitHub OIDC. No long-lived secret to
   manage; verification uses
   `--certificate-identity-regexp` against the GitHub Actions OIDC
   subject. This is the default path and requires no key custody.

2. **Maintainer GPG key for `git tag -s`**. Long-lived. Currently
   held by the lead. The fingerprint is published on the lead's
   GitHub profile and on `keys.openpgp.org`.

When a second maintainer is added, the GPG key custody changes:

- Each maintainer holds their own GPG key, registered with GitHub
  for verified signed tags.
- Tags must be signed by **any one** active maintainer's key. There
  is no shared key; compromising one maintainer's machine never
  forces a project-wide key rotation.
- The lead's key continues to be valid; the new maintainer's key is
  added in a documented commit.

A sealed paper backup of the lead's GPG key (tag-signing only,
revocation certificate, no Cosign material because Cosign is
keyless) is stored in a fireproof safe at the lead's residence.
Recovery instructions are in a sealed envelope at a second
trusted physical location, identified privately to the second
maintainer when one exists.

## Bus-factor recovery

If the lead becomes permanently unavailable and at least one other
maintainer exists:

1. The remaining maintainers continue the project normally. Tag the
   next release under one of their keys, with a `CHANGELOG.md`
   entry noting the lead transition.
2. Update this file: move the previous lead to an "Emeritus" section,
   designate one of the remaining maintainers as the new lead.
3. If the previous lead's GitHub account is also gone (account
   compromise, GitHub account closure), open an issue with GitHub
   Support to transfer org ownership; this requires proof of
   identity from the new lead. GitHub's process is documented at
   <https://docs.github.com/en/organizations/managing-organization-settings/transferring-organization-ownership>.

If the lead becomes permanently unavailable and **no** other
maintainer exists:

1. The project enters dormancy. The README gains a banner directing
   users to the most recent release and to fork.
2. Trusted forks may continue under their own names. Otedama itself
   does not hand over its name; the trademark (such as it is)
   remains with the original lead's estate.
3. Released artifacts and their Cosign signatures remain verifiable
   indefinitely via the public Sigstore transparency log.

## Inactivity policy

A maintainer who has not reviewed a PR or merged a commit in 12
months is considered inactive. The remaining maintainers may move
them to Emeritus by majority vote (or, if only one active
maintainer remains, by that maintainer's decision), updating this
file. Reactivation is automatic on a returning maintainer's
request — no re-vetting required.

## Emeritus maintainers

(none yet)

## Compensation and conflicts of interest

The project has no funding pool to distribute. If this changes
(e.g. via GitHub Sponsors, Open Source Collective fiscal hosting,
or a sponsor reaching out), the maintainers will publish a
`FUNDING.md` describing the inflows, the split rule, and any
conflicts of interest.

Maintainers may accept paid work related to Otedama (consulting,
audits, integrations) provided that:

- The work does not require granting a non-public-PR-able
  modification to the codebase.
- Any code produced is contributed back under Apache 2.0.
- Any conflicts of interest with the maintainer role are disclosed
  in advance to the other maintainers.

## Contact

For routine matters: open a GitHub issue.

For private matters (security advisories, conduct concerns,
maintainer succession discussions): use GitHub's private
vulnerability reporting flow at
<https://github.com/shizukutanaka/Otedama/security/advisories/new>.
This delivers to all current maintainers.

For bus-factor scenarios (lead is unreachable for 30+ days, no
maintainer can release): open a public issue tagged `bus-factor`.
