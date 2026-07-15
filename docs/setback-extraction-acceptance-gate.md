# Setback Extraction Acceptance Gate

Status: proposed (planner ratification gate; NOT yet ratified)
Owner: spine / codes
Scope: the machine-checkable acceptance test every extracted per-jurisdiction
setback table must pass before it is allowed to serve on
`GET /api/local/setbacks/:jurisdictionKey`.

## Why this exists

Setback extraction pulls numeric dimensional rules (front / side / rear yard
minimums, height, coverage) out of legal code text into a structured table
keyed by (jurisdiction, zoning district). That text is error-prone to parse:
units drift (feet vs inches vs stories), district names differ between the GIS
layer and the ordinance, overlay districts and corner-lot rules add
exceptions, and planned-development (PDD / PUD) districts carve the base rule
out entirely. A single wrong number silently corrupts a Property Brief or Site
Analysis with an asserted-looking value that no reviewer ever saw.

The spine's structural commitment #1 is "sell reasoning, not data": every
output carries reasoning chain, source citation, confidence score, timestamp.
A bare setback number with a link to the municode homepage does not satisfy
that commitment. This gate is the enforcement point that makes a later
multi-jurisdiction fan-out safe: no table ships a value that cannot be traced
back to the exact code-section atom that states it, and no value that fails a
rule auto-ships. Failures flag for human review; they do not silently pass and
they do not silently drop.

## What the gate checks

The checker takes two inputs and returns pass / fail per rule per value:

1. an extracted setback table (the `<jurisdiction-key>.json` file, with the
   optional `provenance` block described in the schema section below), and
2. the source code-section atoms for that jurisdiction (the corpus rows the
   value was extracted from, as a JSON array of `{ entityId, sectionNumber,
   bodyText, sourceUrl }`).

### Rule G1 — citation presence (blocking)

Every numeric setback value (`front_ft`, `rear_ft`, `side_ft`,
`side_corner_ft`, `max_height_ft`, `max_lot_coverage_pct`,
`max_impervious_pct`) in every district row must carry a citation in the
district's `provenance` block naming the source atom (`atom_did` /
`section_number`) it was extracted from. A value with no citation is a blocking
failure. The one allowed exception is an explicit `not_specified` marker (rule
G4) which itself must carry a citation to the section that was searched and
found silent.

### Rule G2 — citation resolves to a real atom (blocking)

Every `atom_did` cited in the provenance block must exist in the supplied
source-atom set for that jurisdiction, and its `section_number` must match the
cited section. A citation that points at an atom not in the corpus, or at the
wrong section, is a blocking failure. This is what stops a fabricated section
number from masquerading as a grounded citation.

### Rule G3 — numeric sanity bounds (flag, not auto-reject)

Values outside the plausible band are flagged for human review, never
auto-rejected (a genuine 0 ft downtown-core front setback is real, and a 60 ft
industrial height is real). Bands:

- `front_ft`, `rear_ft`: 0–100
- `side_ft`, `side_corner_ft`: 0–75
- `max_height_ft`: 0–300
- `max_lot_coverage_pct`, `max_impervious_pct`: 0–100

A value outside its band produces a `flagged` result carrying the reason; the
table is not blocked by G3 alone but cannot be marked human-verified while any
G3 flag is open.

### Rule G4 — district coverage (blocking)

Every zoning district named in the jurisdiction's zoning atom(s) must have a
row in the table. A district that the ordinance names but the table omits is a
blocking failure (a Property Brief on a parcel in that district would silently
fall through to base IBC/IRC and never say so). A district whose dimensional
rule the ordinance genuinely does not state gets a row with the affected value
set to the `not_specified` sentinel plus a citation to the searched section —
that is an explicit, honest gap, not a silent one. The set of districts the
gate checks against is supplied to the checker as `expectedDistricts`; deriving
that set from the zoning atom is the extraction step's job, not the checker's.

### Rule G5 — round-trip quote (blocking on verified, flag on asserted)

Every value's provenance must carry a `quote` — the substring of the cited
atom's `bodyText` that states the value — so a reviewer can click the value and
see the code text. For a value marked `human-verified`, the quote must be a
real substring of the cited atom's bodyText (blocking if not). For a value
marked `asserted`, a quote that does not substring-match the atom's bodyText is
`flagged` rather than blocking, because corpus bodyText is frequently
PDF-garbled (see the Bastrop finding below) and the human-review step is
exactly where that garble gets resolved. The gate never lets an unresolved
quote mismatch reach `human-verified`.

### Rule G6 — confidence / verification state present (blocking)

Every value's provenance must carry a `verification_state` of `asserted` or
`human-verified` and a `confidence` in [0, 1]. This is the commitment-#1
confidence signal. `asserted` means "extracted with a citation, not yet
eyeballed by a human"; `human-verified` means a reviewer confirmed the value
against the quoted text. A table may serve with `asserted` values, but any
value that failed G3 (sanity) or G5 (quote) must not carry `human-verified`
until the flag is resolved.

## Pass / fail semantics

- **BLOCK** — any G1, G2, G4, G6 failure, or a G5 failure on a
  `human-verified` value. A table with any BLOCK result must not ship; the
  offending values route to human review.
- **FLAG** — any G3 out-of-band value, or a G5 quote mismatch on an `asserted`
  value. A table may ship with open FLAGs (they are honest, cited, in-review),
  but flagged values may not be promoted to `human-verified` while the flag is
  open. The serving layer may choose to surface flagged values with a
  lower-confidence badge.
- **PASS** — no BLOCK and no FLAG.

The checker exit code is non-zero if any BLOCK result exists (CI-gating), zero
if only FLAGs or clean. This lets a fan-out run the checker in CI and hard-fail
the merge on any un-cited or fabricated value while still allowing
asserted-with-flag tables through for human review.

## Schema (extends the served table, does not break it)

The served wire shape (`LocalSetbackTable` / `LocalSetbackDistrict`) is
unchanged: the route at `artifacts/api-server/src/routes/localSetbacks.ts`
still projects the flat `{ district_name, front_ft, ..., citation_url }` rows
the Site Context FE decodes. The gate reads an **optional** `provenance` block
added per district that the serving route ignores:

```jsonc
{
  "district_name": "SF-6 Single Family",
  "front_ft": 25,
  "rear_ft": 10,
  // ... the flat served values, unchanged ...
  "citation_url": "https://.../sec_XX",
  "provenance": {
    "front_ft": {
      "atom_did": "san_marcos_tx/<edition>/<...>/4.1.2.1",
      "section_number": "4.1.2.1",
      "quote": "Front yard: 25 feet.",
      "confidence": 0.9,
      "verification_state": "human-verified"
    },
    "rear_ft": { "...": "..." }
    // one entry per numeric value; value = "not_specified" allowed
  }
}
```

Rationale for optional-and-additive: it keeps the existing serving contract and
the four already-shipped tables (Bastrop, Grand County, Lemhi, the two
statewide fallbacks) valid on the wire while letting new extractions carry the
audit trail the gate requires. A table with no `provenance` block is treated by
the checker as "legacy, un-gated" — it is reported as such, not silently
passed. The fan-out requirement is that every NEW table carries provenance.

## The Bastrop finding (why round-trip is the load-bearing rule)

The existing Bastrop B3 setback table in the repo carries a single
municode-root `citation_url` per district and no per-value provenance. Running
the checker against the Bastrop B3 code-section atoms in the corpus shows why
that is not good enough: the B3 code is a form/table-heavy PDF, and its
extracted `bodyText` is heavily garbled (page furniture like "223 INTRODUCTION
9 of 265" and flattened sign-permission tables), so the district setback
numbers cannot be round-trip-matched to any clean "front setback = 25 ft"
statement in the atoms. That is precisely the failure mode the gate is built to
catch: a value that looks authoritative but has no traceable source. Bastrop is
therefore a legacy un-gated table under this spec and is a re-extraction
candidate, not a template for citation quality (its shape is the template; its
citations are not).

## How a fan-out should use this gate

1. Extract one jurisdiction. Emit the table with a full `provenance` block, all
   values `asserted`.
2. Run the checker in CI. Fix every BLOCK. Leave FLAGs for human review.
3. A human reviews the FLAGs and the asserted values, promotes confirmed ones
   to `human-verified`, corrects wrong ones.
4. Only then register the table for serving.

Fan-out batch sizing and the human-review checkpoint are covered in the report
that accompanies the pilot; the gate itself is per-table and batch-agnostic.
