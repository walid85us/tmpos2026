# Phase 2.0 — Backend Control Panel — M32 — C-07 Implementation Planning Gate

**Milestone:** Phase 2.0 M32 — C-07 Implementation Planning Gate
**Type:** Docs-only. No implementation. No source/test/runtime change. No commit/push/backup in the milestone body.
**Selected lens:** C-07 Data Source Boundary Readiness Lens (declared `code_config` self-attestation).
**Pre-change accepted checkpoint:** `f1ba53076a9cb363b657ec2dc3a50f97739bba7e`
**Most recent committed milestone:** Phase 2.0 M31 — deepen backend control panel C07 safety contract.
**Decision (this milestone):** **Decision A — C-07 implementation plan locked; proceed to split implementation Part 1 (M33 core provider/read-model only).**
**Implementation status:** C-07 implementation remains **GATED**. M32 plans only; it authorizes nothing.

---

## 0. Scope and Non-Goals (binding)

M32 converts the accepted M31 C-07 safety contract into a precise, split, low-risk implementation plan. It produces exactly one artifact (this document) and changes no source, test, frontend, backend, package, migration, auth, DB/Supabase, config, runtime, or existing documentation; it performs no commit/push/backup. All command results below are **safe summaries only**.

**Safe-summary scope (precision note, carried from M31).** The "no file paths / no raw output / no inventories" rules govern the **C-07 lens runtime output**. They do **not** govern this design-time governance document, which legitimately records the accepted-checkpoint commit hash and the prospective implementation **file paths the milestone charter itself enumerated** as planning content. This document is design-time only and must stay out of any runtime/customer-facing path.

**Runtime-vs-tooling scope (binding clarification).** Every C-07 prohibition (no command execution, no filesystem scanning, no env reads, no network, etc.) governs **C-07's own runtime behavior and emitted output**. It does **not** govern the milestone's dev-time tooling — running the test suite, `tsc`, and static-scan greps during M33 is expected and permitted; only C-07's shipped code must contain none of those behaviors.

**Locked vs to-confirm.** Sections 7–18 are **locked** for implementation, except items explicitly marked "to confirm at M34" (route-layer details that M33 does not build). Any deviation discovered during M33 is a **stop condition** (re-seek authorization), never an in-flight change.

---

## 1. Executive Summary

M32 locks the exact enum tables, label tables (incl. the previously-missing `boundaryPurpose` table), cap tables (with item-vs-warning truncation separated and label-length caps scoped), schema/envelope/item contract (with full-enum field typing and a core-emittable `selfAttestation` field), summary-count contract (with per-count derivations), feature-flag/route/proxy plan, split implementation plan, core implementation package (with an import/dependency boundary), gated frozen-surface touchpoints, test matrix (with explicit exposure negatives and exact mandatory cases), static-scan matrix, and typecheck/transport/browser posture for the C-07 Data Source Boundary Readiness Lens — a DEV-only, production-disabled, read-only **declared `code_config` self-attestation** (not a live verifier, drift detector, diagnostics surface, value oracle, or production-readiness claim).

The plan adopts the **smallest safe first package**: **Option A — M33 Core Provider / Read-Model Only** (exactly four files, no route/adapter/client/UI, no frozen-surface touch).

Baseline reconfirmed at the accepted checkpoint: BCP corpus **1097/1097** (36/36 files green); typecheck **12** unrelated baseline errors, **0** on BCP surfaces; static scan clean. Working tree carries only the two permanently-excluded items.

**Conservative decision: Decision A** → next governed step **Phase 2.0 M33 — C-07 Core Provider / Read-Model Implementation**.

---

## 2. Preflight Result (Section A)

| # | Check | Result |
|---|-------|--------|
| A1 | Branch is `main` | PASS |
| A2 | HEAD == origin/main == `f1ba53076a9cb363b657ec2dc3a50f97739bba7e` | PASS |
| A3 | ahead/behind == 0/0 | PASS |
| A4 | `git status` only `M .replit` + `?? goose-…tar.bz2` | PASS |
| A5 | Nothing staged | PASS (0) |
| A6 | `.gitattributes` absent | PASS (ABSENT) |
| A7 | M31 commit present | PASS (`f1ba530`, subject matches) |
| A8 | HEAD == origin/main ⇒ pre-change backup checkpoint; no extra backup | CONFIRMED |
| A9 | No source/test/runtime change will occur in M32 | CONFIRMED (docs-only) |
| A10 | No commit/push/backup in M32 | CONFIRMED |

Preflight did not fail; work proceeded.

---

## 3. M31 Backup and Safety-Contract Review (Section B)

| # | Item | Status |
|---|------|--------|
| B1 | M31 commit `f1ba53076a9cb363b657ec2dc3a50f97739bba7e` | CONFIRMED |
| B2 | Subject "Phase 2.0 M31 deepen backend control panel C07 safety contract" | CONFIRMED |
| B3 | origin/main matches local HEAD | CONFIRMED (0/0) |
| B4 | Push fast-forward, non-force | CONFIRMED |
| B5 | Exactly one docs file committed | CONFIRMED |
| B6 | No source/test/frontend/backend/runtime change committed | CONFIRMED |
| B7–B25 | C-07 source-inventory/safety-contract deepening, declared-posture framing, non-purpose, allowed/prohibited sources, source-mode lock, data-category, redaction/empty-state/warning, schema/envelope/counts, item/entity, flag/DEV-only/prod-disabled, route/proxy/registration, provider/read-model, client/UI, future tests, static/typecheck/transport/browser, future package, stop conditions — all documented in M31 | CONFIRMED |
| B26 | Decision A documented (proceed to implementation-planning gate) | CONFIRMED |
| B27 | M32 C-07 Implementation Planning Gate selected | CONFIRMED |

---

## 4. C-07 Restatement (carried from M31, unchanged)

C-07 is DEV-only, production-disabled, read-only. It emits a closed-vocabulary **declared `code_config` self-attestation** that the BCP evidence surfaces (C-01…C-06 + the boundary transport harness) are declared to remain inside the approved data-source boundary. It is **not** a live verifier, drift detector, diagnostics surface, value oracle, or production-readiness claim. Drift enforcement remains the existing negative-test + static-scan gates. Allowed runtime sources: `code_config`, `synthetic`, `none` (frozen pattern summaries are design-time authoring input only, excluded from runtime dependencies).

---

## 5. Answers to the M32 Questions (Q1–Q18)

1. Enum tables fully locked — **Yes** (§7). 2. Label tables locked — **Yes** (§8). 3. Cap tables locked — **Yes** (§9). 4. Schema/envelope precise — **Yes** (§10). 5. Item/entity precise — **Yes** (§10). 6. Exact test matrix locked — **Yes** (§16). 7. Static-scan matrix locked — **Yes** (§17). 8. Typecheck posture locked — **Yes** (§18). 9. Transport posture locked — **Yes** (§18). 10. Core reversible files — **the four in §14**. 11. Gated touchpoints — **§15**. 12. Split into milestones — **Yes** (§13). 13. Smallest safe first package — **provider + read-model + tests** (§14). 14. Files allowed in first package — **§14**. 15. Files prohibited — **§14**. 16. Stop conditions — **§20**. 17. Final-report requirements — **§19**. 18. Next milestone — **M33** (§24).

---

## 6. Source / Boundary Posture (carried, locked)

Runtime sources: `code_config` | `synthetic` | `none`. Prohibited (in C-07 runtime/output): DB, SQL, Supabase, Supabase-MCP, live provider, runtime env **values**, secrets, credentials, tokens, cookies, request bodies/headers/query, live tenant/store/customer/user/order records, live audit rows, raw logs, command output, stack traces, runtime diagnostics, package/dependency inventory, file-path inventory, production configuration, network calls, browser session data. (A single named boolean flag/mode gate at the **route** layer — built in a later milestone, not M33 — is not a prohibited env-value read; enumeration and value-exposure are prohibited.)

**`code_config` / `synthetic` mechanism (locked).** `code_config` means **compiled in-source TypeScript constants only** — never a runtime configuration-file read, filesystem read, or `process.env` read. `synthetic` means fixed in-source test fixtures. Neither performs any I/O; the provider/read-model are pure functions of these in-source values.

---

## 7. Enum Tables Lock (Section C)

All enums are **closed**; no free-text; no raw paths/packages/DB/Supabase/provider names; no env values; no diagnostics; no production-readiness claims. **Every "unknown → fallback" target below is itself a member of that field's closed set** (or explicitly "drop the item"); fallback labels are inert (never value oracles).

| # | Field | Locked closed values (incl. fallback member) | Unknown → fallback |
|---|-------|----------------------------------------------|--------------------|
| 1 | `sourceMode` | `code_config` \| `synthetic` \| `none` | `none` (+ warning `source_mode_redacted`) |
| 2 | `freshness` | `static_code_config` (fixed single value) | n/a (constant) |
| 3 | `boundaryKey` | `c01_readiness_summary` \| `c02_registry_readiness` \| `c03_ui_coverage_readiness` \| `c04_route_exposure_readiness` \| `c05_feature_flag_posture` \| `c06_quality_gates_evidence` \| `boundary_transport_matrix` | **drop the item** (+ warning `boundary_key_redacted`); not counted |
| 4 | `ownerSurface` | `bcp_evidence_lens` \| `bcp_transport_harness` \| `redacted` | `redacted` |
| 5 | `dataSourcePosture` | `code_config_only` \| `synthetic_only` \| `not_applicable` \| `redacted` | `redacted` |
| 6 | `dbPosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 7 | `sqlPosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 8 | `supabasePosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 9 | `liveProviderPosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 10 | `runtimeEnvPosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 11 | `commandOutputPosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 12 | `diagnosticsPosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 13 | `rawEvidencePosture` | `asserted_absent_code_config` \| `not_applicable` \| `redacted` | `redacted` |
| 14 | `valueOraclePosture` | `no_value_oracle` \| `not_applicable` \| `redacted` | `redacted` |
| 15 | `productionPosture` | `production_disabled` \| `not_applicable` \| `redacted` | `redacted` |
| 16 | `mutationPosture` | `mutation_blocked` \| `not_applicable` \| `redacted` | `redacted` |
| 17 | `customerExposurePosture` | `no_customer_exposure` \| `not_applicable` \| `redacted` | `redacted` |
| 18 | `evidenceStatus` | `asserted_within_boundary` \| `redacted` \| `unknown_redacted` | `unknown_redacted` |
| 19 | `redactionPosture` (envelope) | `enforced` (fixed) | n/a (constant) |
| 20 | `logExposurePosture` (envelope) | `no_raw_logs` (fixed) | n/a (constant) |
| 21 | `emptyStateReason` | `no_boundary_items` \| `no_live_source` \| `input_redacted` | `input_redacted` |
| 22 | `warnings[]` | `source_mode_redacted` \| `posture_value_redacted` \| `boundary_key_redacted` \| `item_count_capped` \| `warning_count_capped` \| `no_live_source` | unknown warning dropped |
| 23 | `evidenceLabels[]` (envelope) | `code_config_declared` \| `synthetic_fixture` \| `none_empty` \| `redacted` | `redacted` |
| 24 | `selfAttestation` (envelope, fixed) | `design_time_code_config` | n/a (constant) |
| 25 | `boundaryPurpose` (per item, closed map — see §8 table) | one closed label per `boundaryKey` \| `redacted` | `redacted` |

Two posture families: **absence-postures** (#6–#13) use `asserted_absent_code_config` (declared, not live-verified); **state-postures** (#14–#17) use their own state vocabulary. The `asserted_*` naming guarantees no field implies live verification. The fixed `selfAttestation = design_time_code_config` (#24) lets the **core (provider/read-model) carry the non-verifier framing** without any UI string.

**No request-driven channels (locked).** Every field, posture, count, and empty-state above is a function of static `code_config`/`synthetic` input only and is **not driven by per-request, attacker-controlled input**. Therefore the `no_live_source` vs `input_redacted` distinction, and every count, is constant for a given build — none is a request-cardinality or value-oracle channel. Enumerating C-01…C-06 + the transport harness as boundary keys is **intentional DEV-only internal architecture** (lens identifiers already accepted as safe), not a prohibited customer/DB/provider/path value.

---

## 8. Label Tables Lock (Section D)

Closed safe display labels (no raw DB/table/SQL/Supabase/URL/key/token/credential/ID/permission/role/env/path/package/version/command/stack/diagnostic/production-endpoint/provider value; no production-readiness claim). **Length caps are per §9 and are scoped by label group.**

| # | Label group | Locked value(s) |
|---|-------------|-----------------|
| 1 | Lens title (≤64) | "C-07 Data Source Boundary Readiness" |
| 2 | Lens short description (≤200, narrative constant) | "Declared code-config self-attestation that Backend CP evidence surfaces stay inside the approved data-source boundary." |
| 3 | **Self-attestation disclaimer (UI label, ≤200)** | **"C-07 is a design-time self-attestation lens, not a live verifier."** |
| 4 | Boundary labels (per `boundaryKey`, ≤64) | `c01_readiness_summary`→"C-01 Readiness Summary"; `c02_registry_readiness`→"C-02 Registry Readiness"; `c03_ui_coverage_readiness`→"C-03 UI Coverage Readiness"; `c04_route_exposure_readiness`→"C-04 Route Exposure Readiness"; `c05_feature_flag_posture`→"C-05 Feature-Flag Posture"; `c06_quality_gates_evidence`→"C-06 Quality-Gates Evidence"; `boundary_transport_matrix`→"Boundary Transport Harness" |
| 5 | **Boundary purpose (per `boundaryKey`, ≤64) — NEW closed table** | `c01_readiness_summary`→"Readiness summary evidence"; `c02_registry_readiness`→"Registry readiness evidence"; `c03_ui_coverage_readiness`→"UI coverage readiness evidence"; `c04_route_exposure_readiness`→"Route exposure readiness evidence"; `c05_feature_flag_posture`→"Feature-flag posture evidence"; `c06_quality_gates_evidence`→"Quality-gates evidence"; `boundary_transport_matrix`→"Boundary transport harness evidence"; fallback→"Redacted" |
| 6 | Posture labels (≤64) | `asserted_absent_code_config`→"Declared absent (code-config)"; `code_config_only`→"Code-config only"; `synthetic_only`→"Synthetic only"; `production_disabled`→"Production disabled"; `mutation_blocked`→"Mutation blocked"; `no_value_oracle`→"No value oracle"; `no_customer_exposure`→"No customer exposure"; `not_applicable`→"N/A"; `redacted`→"Redacted" |
| 7 | Warning labels (≤64) | `source_mode_redacted`→"Source-mode redacted"; `posture_value_redacted`→"Posture value redacted"; `boundary_key_redacted`→"Boundary key redacted"; `item_count_capped`→"Item count capped"; `warning_count_capped`→"Warning count capped"; `no_live_source`→"No live source (expected)" |
| 8 | Empty-state labels (≤64) | `no_boundary_items`→"No boundary items"; `no_live_source`→"No live source (expected)"; `input_redacted`→"Input redacted" |
| 9 | Evidence labels (≤64) | `code_config_declared`→"Code-config declared"; `synthetic_fixture`→"Synthetic fixture"; `none_empty`→"None / empty"; `redacted`→"Redacted" |
| 10 | Status labels (`evidenceStatus`, ≤64) | `asserted_within_boundary`→"Declared within boundary"; `unknown_redacted`→"Unknown (redacted)"; `redacted`→"Redacted" |
| 11 | Blocked/disabled labels | route-disabled → standard BCP 404 (no body text); flag-off → standard disabled behavior (no value emitted) |
| 12 | Owner-surface labels (≤64) | `bcp_evidence_lens`→"BCP evidence lens"; `bcp_transport_harness`→"BCP transport harness"; `redacted`→"Redacted" |

**`boundaryKey` → `ownerSurface` mapping (locked):** `c01_readiness_summary`, `c02_registry_readiness`, `c03_ui_coverage_readiness`, `c04_route_exposure_readiness`, `c05_feature_flag_posture`, `c06_quality_gates_evidence` → `bcp_evidence_lens`; `boundary_transport_matrix` → `bcp_transport_harness`. (M33 does not re-decide this.)

No label may be derived from any prohibited value; all are static constants. **Every displayable enum value above has exactly one static label** (status, posture, warning, empty-state, evidence, boundary, purpose, owner-surface). (Display labels for `sourceMode`/`freshness` enum values are a UI concern and are added at the UI milestone M35; M33 is data-only.)

---

## 9. Cap Tables Lock (Section E)

| # | Cap | Locked value | Notes |
|---|-----|--------------|-------|
| 1 | Max boundary items | **7** (one per closed key; safety ceiling 12) | dedup one-item-per-key (§10); cap is never hit in practice |
| 2 | Max warnings | **12** | warnings array reserves its final slot for `warning_count_capped` |
| 3 | Max envelope evidence labels (total, not per item) | **4** | `evidenceLabels` is **envelope-level**; not an item field |
| 4 | Summary-count fields | **16** (fixed) | exactly the §11 set; never grows |
| 5 | Max UI rows/cards | **7** | one row per retained boundary item |
| 6 | Max per-item / posture / warning / empty-state / evidence / boundary / purpose **label** length | **64 chars** | scoped to closed display labels |
| 7 | Max lens-title length | **64 chars** | single static constant |
| 8 | Max narrative-constant length (short description, UI disclaimer) | **200 chars** | the two narrative constants only |

**Item vs warning truncation (separated):** *Items* are deduplicated one-per-key and emitted in fixed order (max 7); if the defensive ceiling (12) were ever exceeded, excess **items** are dropped and the **warning** `item_count_capped` is emitted into the warnings array. `item_count_capped` is a **warning, never an item slot**, and is **defensive-only**: with the fixed 7-key closed set and unknown keys discarded, natural data never reaches the ceiling, so `item_count_capped` is unreachable by real input and is exercised only via a synthetic over-ceiling test fixture (§16 R20). *Warnings* are capped at 12 with the **final slot reserved** for `warning_count_capped`, so the cap signal is never itself dropped.

**Cardinality safety (locked):** caps are deterministic; capped output reveals no raw input cardinality; discarded unknown inputs (unknown `boundaryKey`) do **not** increment any count; only retained items with a field-level redaction increment `unknownRedacted`; summary counts can never become a file/package/env/table inventory oracle (they count only the fixed ≤7 declared set's retained items).

---

## 10. Schema / Envelope / Item Contract Lock (Section F)

**Schema (locked):** `bcp.c07.data-source-boundary-readiness.v1-code-config`.

**Envelope fields (locked names/types/values — each type is the FULL closed enum so the fallback is a member):**

| Field | Type (full closed enum / shape) | Fallback |
|-------|----------------------------------|----------|
| `schemaVersion` | constant schema string | constant |
| `selfAttestation` | `design_time_code_config` (fixed) | constant |
| `sourceMode` | `code_config` \| `synthetic` \| `none` | `none` |
| `freshness` | `static_code_config` (fixed) | constant |
| `summaryCounts` | fixed 16-key integer object (§11) | zeros |
| `boundaryItems` | bounded array (≤7) of locked item objects | `[]` |
| `emptyState` | boolean | `true` if no items |
| `emptyStateReason` | `no_boundary_items` \| `no_live_source` \| `input_redacted` | `input_redacted` |
| `warnings` | bounded array (≤12) of §7.22 labels | `[]` |
| `redactionPosture` | `enforced` (fixed) | constant |
| `productionPosture` | `production_disabled` \| `not_applicable` \| `redacted` | `redacted` |
| `mutationPosture` | `mutation_blocked` \| `not_applicable` \| `redacted` | `redacted` |
| `dataSourcePosture` | `code_config_only` \| `synthetic_only` \| `not_applicable` \| `redacted` | `redacted` |
| `logExposurePosture` | `no_raw_logs` (fixed) | constant |
| `valueOraclePosture` | `no_value_oracle` \| `not_applicable` \| `redacted` | `redacted` |
| `evidenceLabels` | bounded array (≤4 total) of §7.23 labels | `[]` |

**`generatedAt`: confirmed permanently EXCLUDED** (runtime timing value; breaks determinism). No runtime time reintroduced. Freshness = fixed `static_code_config` only.

**Item contract (locked) — fields exactly:** `boundaryKey`, `boundaryLabel`, `boundaryPurpose`, `ownerSurface`, `sourceMode`, `dataSourcePosture`, `dbPosture`, `sqlPosture`, `supabasePosture`, `liveProviderPosture`, `runtimeEnvPosture`, `commandOutputPosture`, `diagnosticsPosture`, `rawEvidencePosture`, `valueOraclePosture`, `productionPosture`, `mutationPosture`, `customerExposurePosture`, `evidenceStatus`. (`evidenceLabels` is **envelope-level, not an item field**.) All values from §7; `boundaryLabel`/`boundaryPurpose`/`ownerSurface` from the §8 closed tables. **Ordering:** deterministic, fixed in the §7.3 key order. **Dedup:** at most one item per `boundaryKey` (first occurrence wins; later duplicates dropped). **Unknown `boundaryKey`:** dropped, not counted (+ `boundary_key_redacted`). **Unknown closed-field value:** normalized to `redacted`/`none`, item retained, contributes to `unknownRedacted`.

**Boundary keys (final, locked):** the seven in §7.3. **`future_lens_placeholder` EXCLUDED** until a future lens exists.

---

## 11. Summary Counts Contract Lock (Section G)

Fixed 16-key integer object (no other key permitted). Each is a non-negative integer in `[0, total]` (`total ≤ 7`), derived **only** from the closed posture statuses of **retained, deduplicated** `boundaryItems`:

| Count | Derivation predicate (over retained items) |
|-------|--------------------------------------------|
| `total` | number of retained items (≤7) |
| `codeConfigOnly` | items with `dataSourcePosture = code_config_only` |
| `syntheticOnly` | items with `dataSourcePosture = synthetic_only` |
| `noDb` | items with `dbPosture = asserted_absent_code_config` |
| `noSql` | items with `sqlPosture = asserted_absent_code_config` |
| `noSupabase` | items with `supabasePosture = asserted_absent_code_config` (covers Supabase **and** Supabase-MCP) |
| `noLiveProvider` | items with `liveProviderPosture = asserted_absent_code_config` |
| `noRuntimeEnvValues` | items with `runtimeEnvPosture = asserted_absent_code_config` |
| `noRawDiagnostics` | items with `diagnosticsPosture = asserted_absent_code_config` |
| `noCommandOutput` | items with `commandOutputPosture = asserted_absent_code_config` |
| `productionDisabled` | items with `productionPosture = production_disabled` |
| `readOnly` | items with `mutationPosture = mutation_blocked` (declared core posture; **no route dependency** in M33) |
| `mutationBlocked` | items with `mutationPosture = mutation_blocked` (coincides with `readOnly` by design) |
| `valueOracleBlocked` | items with `valueOraclePosture = no_value_oracle` |
| `customerExposureBlocked` | items with `customerExposurePosture = no_customer_exposure` |
| `unknownRedacted` | retained items having **≥1 closed field normalized to `redacted`** |

**Notes:** duplicate keys are deduped before counting (no double-count). `sourceMode` normalization to `none` is signalled by the `source_mode_redacted` **warning**, and does **not** contribute to `unknownRedacted` (which counts item-field redactions only). `readOnly` and `mutationBlocked` share the same predicate and are always numerically equal **by design** (two named declared postures, one source field). `rawEvidencePosture` is an item field with **no** corresponding summary count, **by design** (the 16-key set is fixed and closed); implementers must **not** add a `noRawEvidence` count. **Secret/token/credential non-use is a SEPARATE provider invariant** — the provider references no secret material at all; it is **not** "proven by" `noRuntimeEnvValues`/`valueOracleBlocked`, which are independent declared postures. **Prohibited counts:** raw file/dependency/package/table/environment-key/request/tenant/customer/user counts; route-inventory counts outside the fixed declared set; raw scanner results; internals-revealing diagnostics counts.

---

## 12. Feature Flag / Route / Proxy Plan Lock (Section H)

**Confirmed names (locked):** flag `ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS`; server route `/dev/bcp/data-source-boundary-readiness`; frontend proxy `/__identity/dev/bcp/data-source-boundary-readiness`.

Route plan (locked names; behavioural details **to confirm at M34** against the frozen contract; **NOT built in M33**): default-off; DEV-only; production-disabled; read-only `GET`; `HEAD` bodyless 200; `OPTIONS` 204; mutation methods 405; hostile request ignored; server-sourced authority only; no request-body/query/header/cookie authority; safe error envelope (`500 → {status:'error'}`); no DB/Supabase/live provider; no customer-facing route; no SaaS-navigation route; isolated identity-API registration only; route-registration + adapter + route-handler tests; matrix extension if route/adapter built; server-pinned guard (no request-auth input).

**To confirm at M34 (not asserted here):** the exact `Allow` header method list and the exact flag-off/DEV-disabled response semantics are **inherited verbatim from the frozen C-01…C-06 transport contract** and will be confirmed against it at the route/adapter milestone. M33 builds no route, so these are not blocking.

---

## 13. Implementation Split Plan (Section I)

Evaluated options A–D. **Selected: Option A — M33 Core Provider / Read-Model Only (Risk: Low).**

| Option | Scope | Risk | Selected |
|--------|-------|------|----------|
| **A** | Provider + read-model + their tests (4 files); no route/adapter/registration/client/UI; no frozen-surface touch | **Low** | **✔** |
| B | A + route + adapter + route tests | Medium | — |
| C | Full C-07 in one milestone | High | — |
| D | Another docs-only deepening pass | Low | — (unnecessary) |

Rationale: Option A is the smallest package producing real, tested value (the pure deterministic core all later layers depend on) while touching **zero** frozen surfaces and creating **zero** routable/customer-facing/UI exposure.

**Forward milestone shape (indicative, each separately authorized):** M33 = core; M34 = route + adapter + test-level registration, then a gated `server.ts` live-mount + matrix-extension sub-step; M35 = client + UI card (incl. the disclaimer-string test), then a gated `screens.tsx` registration sub-step.

---

## 14. Core Implementation Package Lock (Section J) — M33

**Allowed files for M33 (exactly four):**
1. `server/bcp-pilot/bcpC07DataSourceBoundaryProvider.ts`
2. `server/bcp-pilot/bcpC07DataSourceBoundaryProvider.test.ts`
3. `server/bcp-pilot/bcpC07DataSourceBoundaryReadModel.ts`
4. `server/bcp-pilot/bcpC07DataSourceBoundaryReadModel.test.ts`

**Import / dependency boundary (locked).** The four files may import only: pure in-repo TypeScript **types/interfaces** and **local C-07 constants/enums** they define, plus standard pure language/test utilities (e.g. the `tsx` test runner entry, `assert`). They **must not** import from: any route/adapter/registration module; `server/platform-identity/server.ts`; `bcpAuthorizationGuard.ts`; `bcpTransportMatrix*`; auth/audit/identity/session modules; DB/Supabase/live-provider clients; runtime-config/env modules; `fs`, `child_process`, `net`, `http(s)`, or any network/filesystem/process API; any frozen-surface module. The provider/read-model are pure functions of hardcoded `code_config`/`synthetic` input.

**Prohibited for M33 (non-exhaustive, binding):** `…ReadOnlyRoute.ts`/`.test.ts`; `…ReadOnlyExpressAdapter.ts`/`.test.ts`; `bcpC07RouteRegistration.test.ts`; `src/backend-control-plane/bcpC07Client.ts`/`.test.ts`; `C07DataSourceBoundaryReadinessCard.tsx`; `src/backend-control-plane/screens.tsx`; `server/platform-identity/server.ts`; `server/bcp-pilot/bcpAuthorizationGuard.ts`; `server/bcp-pilot/bcpTransportMatrix.test.ts`; `src/App.tsx`; SaaS navigation; `package.json`; `package-lock.json`; migrations; seeds; `shared/**`; auth/audit/identity/session; DB/Supabase files; browser tooling; generated artifacts; and the permanently-excluded `.replit`, `.gitattributes`, goose tarball.

M33 creates **no** route, adapter, registration, client, UI, or matrix integration. It proves the core provider/read-model contract only.

---

## 15. Future Gated Touchpoints Lock (Section K)

| Touchpoint | Required? | In M33? | Authorization | Pre-condition | Protecting tests | Stop condition |
|-----------|-----------|---------|---------------|---------------|------------------|----------------|
| `server/platform-identity/server.ts` (live mount) | Eventually | **No** | Separate, at route/adapter milestone | route + adapter exist & reviewed | route-registration + matrix | any M33 touch = STOP |
| `src/backend-control-plane/screens.tsx` (card registration) | Eventually | **No** | Separate, at UI milestone | client + card exist & reviewed | UI card + nav | any M33 touch = STOP |
| `server/bcp-pilot/bcpAuthorizationGuard.ts` | **Reuse-only** | **No** | Modification needs separate authorization | reuse pinned guard | existing guard tests green | any modification = STOP |
| `server/bcp-pilot/bcpTransportMatrix.test.ts` | If route/adapter built | **No** | Separate, explicit matrix-extension authorization | route + adapter exist | extended matrix green | any M33 touch = STOP |

---

## 16. Future Test Matrix Lock (Section L) — M33 provider/read-model

Mandatory named cases below (these exact cases are required; additional **parameterized variants** of the same cases are permitted, but no new behavior category may be added without re-planning).

**Provider — 13 mandatory cases:** (P1) deterministic output across repeated calls; (P2) `selfAttestation = design_time_code_config` present; (P3) only `code_config`/`synthetic`/`none` source-modes; (P4) **no `generatedAt`/any runtime timestamp** field; (P5) no DB/SQL/Supabase/live-provider source categories referenced; (P6) no runtime env value referenced; (P7) no command output; (P8) no diagnostics; (P9) no package/file-path inventory; (P10) bounded items (≤7, one per key); (P11) the seven closed boundary keys only; (P12) closed warning labels only; (P13) no raw identifiers/secrets/credentials/tokens in any output field.

**Read-model — 20 mandatory cases:** (R1) closed-enum enforcement on every field; (R2) unknown `sourceMode` → `none` + `source_mode_redacted`; (R3) unknown `boundaryKey` → item dropped, not counted, + `boundary_key_redacted`; (R4) unknown posture value → `redacted` + item retained; (R5) `summaryCounts` are exactly the 16 keys **and each count equals its §11-derived value** over retained items (count-VALUE correctness, not just key-set); (R6) `unknownRedacted` counts retained field-redacted items only; (R7) discarded unknown keys not counted; (R8) duplicate `boundaryKey` deduped (first wins); (R9) deterministic ordering; (R10) item-truncation vs warning-truncation behave per §9 (reserved `warning_count_capped` slot); (R11) no raw value leakage; (R12) empty-state distinguishes `no_live_source` vs `input_redacted`; (R13) no value-oracle behavior (output invariant to any prohibited value); (R14) no production-readiness claim; (R15) closed absence-posture fields/values present but **no raw DB/Supabase/live-provider identifiers/values**; (R16) deterministic warning construction (fixed precedence + dedup, §9); (R17) `boundaryKey`→`boundaryLabel` mapping matches §8.4; (R18) `boundaryKey`→`boundaryPurpose` matches §8.5 **and** `boundaryKey`→`ownerSurface` matches the §8 mapping; (R19) envelope `evidenceLabels` capped at ≤4 (defensive over-cap fixture); (R20) `item_count_capped` defensive-only — exercised via a synthetic over-ceiling fixture, never by natural ≤7 data.

**Explicit exposure negatives (M33 output-level):** no identifiers, secrets, credentials, or tokens appear in any emitted field (covered by P13/R15). *Request-authority negatives* (cookies, request headers, query, body carry no authority) belong to the **route/adapter milestone** (no route exists in M33) and are not M33 tests.

**Regression:** existing C-01…C-06 tests stay green; M27 matrix stays green; aggregate corpus increases **only** by the M33 tests and remains all green.

The UI **disclaimer-string** test (asserting the §8.3 wording renders) is deferred to the **UI milestone (M35)** — M33 has no UI; M33 instead asserts the framing via `selfAttestation` (P2) and the declared postures.

---

## 17. Static Scan Matrix Lock (Section M) — M33

Static scans (dev-time tooling, permitted) must confirm **C-07 source introduces none of:** package/lockfile changes; dependency installs; browser tooling; server-startup changes; sockets/listeners/ports; outbound network I/O; child/background processes; filesystem scanning; filesystem writes; DB/Supabase access; SQL; Supabase-MCP; live-provider calls; production/customer-facing exposure; mutation/action behavior; raw logs; raw command output; raw transport output; raw response/header dumps; stack-trace exposure; raw-error exposure; runtime-diagnostics exposure; package/dependency/version exposure; file-path-inventory exposure; process-detail exposure; PID/port/timing exposure; `process.env` enumeration; environment-value exposure; value-oracle behavior; production-readiness claims; frozen-source drift outside the four authorized files; **prohibited imports per the §14 import boundary**.

**Match classification (each hit must be one of):** safe enum · safe closed label · safe negative assertion · safe synthetic test fixture · safe absence posture · **unsafe executable behavior** (the only failing class). Counts and classifications only — no raw scan output in reports.

**Gate-checked, not merely implied.** M33's no-exposure property is **prohibited and gate-checked**, not assumed from file selection alone (a `.ts` file can import anything). It rests on three enforced controls that must **all actually run and pass before M33 acceptance**: the §14 import boundary, this §17 static-scan matrix, and the §20 stop conditions.

---

## 18. Typecheck / Transport / Browser Posture Lock (Section N)

**Typecheck:** 12 unrelated baseline errors may remain unchanged (do **not** fix); **0** in the four M33 files; **0** in `server/bcp-pilot`; **0** in `src/backend-control-plane`.

**Transport:** M33 creates no route/adapter; matrix extension **not** required in M33; if route/adapter is built later, C-07 must be added to the matrix; real-socket live transport remains deferred; no server/socket evidence claimed unless separately authorized.

**Browser:** no browser tooling; no package/lockfile change; browser evidence remains waived for Phase 2.0 only; reopen before production readiness / Phase 3 / Phase 4 / customer-facing release.

---

## 19. M33 Final Report Requirements (Section O)

If M33 (Option A) is selected, its final report must contain these 31 sections: 1 Executive Summary; 2 Preflight Result; 3 Files Created; 4 Files Modified; 5 Files Confirmed Untouched; 6 M32 Planning-Contract Review; 7 Provider Implementation Summary; 8 Read-Model Implementation Summary; 9 Enum/Label/Cap Table Summary; 10 Declared-Posture / Self-Attestation Summary; 11 No Runtime Source Confirmation; 12 No DB/SQL/Supabase/Live-Provider Confirmation; 13 No Env-Value/Secret/Token Confirmation; 14 No Diagnostics/Command-Output/Inventory Confirmation; 15 No Route/Adapter/Registration Confirmation; 16 No Client/UI/Screen Confirmation; 17 No Frozen-Surface Touch Confirmation; 18 Tests Added; 19 Test Results; 20 C-01…C-06 Regression Results; 21 M27 Matrix Regression Result; 22 Typecheck Result; 23 Static Scan Results; 24 Transport Evidence Status; 25 Browser Evidence Waiver; 26 Independent Review Results; 27 Risks/Accepted Residuals; 28 Git Status; 29 No Commit/Push/Backup Confirmation; 30 Acceptance Recommendation; 31 Recommended Next Step.

---

## 20. M33 Stop Conditions (Section P)

M33 must stop and re-seek authorization if implementation would require any of: touching any file outside the four allowed M33 files; violating the §14 import boundary; creating a route/adapter/registration; touching `server.ts`/`bcpAuthorizationGuard.ts`/`bcpTransportMatrix.test.ts`/`screens.tsx`/`App.tsx`; creating a client or UI; adding SaaS navigation; C-07 runtime reading DB/SQL/Supabase/Supabase-MCP/live provider; C-07 runtime reading env **values**; C-07 output exposing secrets/tokens/credentials/identifiers; C-07 runtime scanning package/dependency inventory; C-07 runtime scanning file paths; C-07 runtime executing commands; C-07 exposing diagnostics; creating production/customer-facing exposure; adding mutation/action behavior; changing package/lockfile; adding dependencies; adding browser tooling; generating artifacts; a test failure not fixable inside the four allowed files; adding typecheck errors in C-07 or BCP surfaces; an unsafe static-scan finding; or an unresolved independent-review blocker. (These govern **C-07 runtime/output**; the milestone's own dev-time tests/typecheck/scans are expected and not prohibited.)

---

## 21. Baseline Reconfirmation (Section Q) — safe summaries only

| Surface | Result |
|---------|--------|
| Files run / green / failed | 36 / 36 / 0 |
| Aggregate | **1097 / 1097** |
| M27 · C-01 · C-02 · C-03 · C-04 · C-05 · C-06 | 106 · 109 · 126 · 130 · 146 · 170 · 310 (all full) |

**Typecheck:** 12 unrelated baseline errors (unchanged); 0 in `src/backend-control-plane`; 0 in `server/bcp-pilot`; 0 across C-01…C-06.
**Static scans:** clean — no package/lockfile change; Supabase createClient/import = 0; pg/SQL query = 0; outbound-absolute-fetch = 0; no production/customer-facing surface; forbidden constructs in C-01…C-06 appear only as negative test assertions; no server/socket/network/process/filesystem artifact posture in the M27 harness.

These figures are **point-in-time read-only observations** taken during M32 (read-only execution, no code change); they must be **re-confirmed at M33 preflight** before any implementation begins.

---

## 22. Independent Review Results (Section R)

Three independent passes ran (security/exposure implementation-plan lens; planning/split-package/test-matrix lens; cross-model). **All three returned a precision-BLOCKED verdict** against the draft; every finding was **documentation-precision** (M32 is docs-only — no code exists, so none reflects a live exposure), and **all were reconciled in documentation only**. No finding required a source/test/runtime change.

- **Cross-model:** closed-enum fallback validity; `evidenceLabels`/`boundaryPurpose` placement; item-vs-warning truncation; full-enum envelope typing; count derivations; `readOnly`/secret-invariant wording; import boundary; label-cap scoping; disclaimer-vs-no-UI; exact test counts; runtime-vs-tooling scoping; deterministic warning construction; status-label completeness — **all applied**. (First attempt failed on an environment sandbox error; re-run with the document embedded — recorded honestly.)
- **Security lens BLOCKER + notes:** missing `boundaryPurpose` closed table (**resolved** — §7 #25 + §8 #5); `synthetic_only` carrier (**resolved** — §7.5 + §11); `code_config` mechanism definition (**added** — §6); `evidenceLabels` placement (**resolved** — envelope-level); disclaimer envelope home (**resolved** — `selfAttestation` field + test deferred to M35); `ownerSurface` label group (**added** — §8 #12); empty-state not request-driven (**added** — §7 note); "incapable"→"prohibited and gate-checked" (**added** — §17); baseline point-in-time (**added** — §21); internal-topology intentional (**noted** — §7).
- **Planning lens BLOCKER + notes:** missing `boundaryPurpose` table (**resolved**); `syntheticOnly` derivation (**resolved** — §11); `evidenceLabels` placement (**resolved**); no count-VALUE test (**added** — R5/§16); absence-posture range #6–#13 (**corrected** — §7); item-cap/`item_count_capped` defensive + dedup (**resolved** — §9/§10); evidence-label cap test + label/purpose/owner mapping tests (**added** — R17–R20); `evidenceLabels` fallback member (**resolved** — §7.23 + §8 #9); `readOnly`==`mutationBlocked` intentional (**noted** — §11); `rawEvidencePosture` no-count by design (**noted** — §11); `ownerSurface` mapping tabulated (**added** — §8); UI-only labels (**deferred** to M35 — §8).

The two subagent BLOCKERs (`boundaryPurpose`, `syntheticOnly`) were reviewed against the pre-reconciliation draft and were **already resolved** by the cross-model reconciliation applied immediately before their return; the remaining net-new notes were then applied as above. No verdict invented. With all findings applied, no safety/exposure/authority/value-oracle/sensitive-data blocker remains; the plan is internally consistent and implementable. **Decision A stands.**

---

## 23. M32 Decision (Section S)

**Decision A — C-07 IMPLEMENTATION PLAN LOCKED; PROCEED TO SPLIT IMPLEMENTATION PART 1.**

Enum/label/cap tables are locked and internally consistent after reconciliation; schema/envelope/item and summary-count contracts are precise with derivations; the M33 test matrix, static-scan matrix, import boundary, and typecheck/transport/browser postures are locked; the smallest safe first package is provider/read-model only (four files); frozen-surface touchpoints are isolated and gated. Implementation remains gated until M33 is separately authorized.

---

## 24. Next Governed Step Selection (Section T)

**Candidate 1 — Phase 2.0 M33 — C-07 Core Provider / Read-Model Implementation.** Selected (Decision A). Candidate 2 (full implementation) premature; Candidate 3 (another planning pass) unnecessary (plan is precise); Candidate 4 (return to discovery) unwarranted.

---

## 25. Non-Readiness Statements (Section U)

Phase 2.0 remains: not production readiness; not customer-facing release; not Phase 3 controlled actions; not Phase 4 production readiness; not live DB/Supabase reads; not live-provider reads; not Supabase-auth enablement; not Firebase-to-Supabase cutover; not browser-evidence completion for production/customer-facing release. Firebase authoritative; Supabase dormant/shadow/readiness-only; Backend CP DEV-only and read-only in Phase 2.0; C-07 not implemented during M32.

---

## 26. Risks / Accepted Residuals

- **C-07 not implemented; planning-only; declared-posture (not a verifier)** — by design.
- **Browser evidence waived (Phase 2.0 only)** — must reopen before production readiness / Phase 3 / Phase 4 / customer-facing release.
- **Real-socket live transport deferred** — validated by the transport-agnostic matrix.
- **12 unrelated baseline typecheck errors** — outside BCP scope; not to be fixed here.
- **Frozen-surface touchpoints gated** — `server.ts`, `screens.tsx`, `bcpAuthorizationGuard.ts` (reuse-only), `bcpTransportMatrix.test.ts` — each requires separate authorization.
- **Route-layer details to confirm at M34** — exact `Allow` method list and flag-off semantics inherited from the frozen contract, confirmed at the route milestone (M33 builds no route).
- **Enum tightening from M31** — absence-posture family narrowed from M31's provisional superset to the locked set (§7); intentional and recorded.

---

## 27. Verification Before Final Report (Section V)

1. Only the M32 documentation file was created. ✔
2–20. No source/test/frontend/backend/client/provider/read-model/route/adapter/registration/UI change; no `server.ts`, `bcpAuthorizationGuard.ts`, `bcpTransportMatrix.test.ts`, `screens.tsx`, or `App.tsx` change; no SaaS-nav; no `package.json`/`package-lock.json`; no migration/seed; no `shared/**`; no auth/audit/identity/session; no DB/Supabase file. ✔
21. `.replit` unstaged/untouched. ✔ 22. goose tarball untracked. ✔ 23. `.gitattributes` absent. ✔
24. Tests/scans/typecheck/planning reported honestly as safe summaries. ✔ 25. No not-run evidence (all ran). ✔ 26. Independent-review capture explicit and honest (§22, chat §25). ✔
27. Expected post-milestone `git status`: `M .replit`, `?? docs/…m32….md`, `?? goose-…tar.bz2`. ✔

---

## 28. No Commit / Push / Backup Confirmation

No commit, push, or backup was performed in this milestone. The pre-change checkpoint (`f1ba530`, HEAD == origin/main, 0/0) serves as the backup. Commit/push/backup are deferred to the separately-authorized **Phase 2.0 M32 — Scoped Commit and Backup Authorization** step.

---

## 29. Recommended Next Step

If accepted: **Phase 2.0 M32 — Scoped Commit and Backup Authorization** (stage only this file; standing scoped-commit rules), then proceed to **Phase 2.0 M33 — C-07 Core Provider / Read-Model Implementation** (the four-file core package). Implementation remains gated until M33 is authorized; stop for owner review.
