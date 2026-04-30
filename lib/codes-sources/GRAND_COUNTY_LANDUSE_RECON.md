# Grand County, UT Land Use Code — Phase 1 ingestion recon

> **Recommendation (TL;DR).** Path A (Municode) is unavailable and the
> Path B source assumed by the task brief (a PDF on grandcountyutah.net)
> does not exist; the County's Land Use Code page 301-redirects off-site
> to a third-party HTML codification. **Take Path B in its actual form
> — direct scrape of `https://www.codepublishing.com/UT/GrandCounty/`
> ("Path B′" below to flag the deviation from "PDF" in the task brief).**
> Add a third book to the existing `grand_county_ut` jurisdiction
> (`codeBook: LAND_USE`, `sourceName: grand_county_landuse_html`).
> Estimated **~94 atoms at H3 "section" granularity** (≈120–150 after
> over-cap splits), **~$0.003 embedding cost** with
> `text-embedding-3-small`, **~30–60 s warmup duration** for one
> process. **A new HTML adapter is required** (the existing
> `grand_county_html` adapter is hard-coded to one Design-Criteria page;
> the existing `grand_county_pdf` adapter does not apply because the
> Land Use Code is not a PDF). No parser changes to the Bastrop-tuned
> `municode/parser.ts` are anticipated — Municode is not in scope.

This report fulfills Task #5 (Phase 1 of the Grand County Land Use Code
ingestion sprint). No code or DB writes were made; this file is the only
deliverable.

---

## 1. BEFORE baseline — retrieval probe

The Atom Inspector page (`/dev/atoms`) at `design-tools` does not itself
expose the similarity probe. The probe used by the Code-Library / chat
flow lives at `POST /api/dev/atoms/retrieve` (header-gated,
`x-snapshot-secret`). I exercised it against the snapshot secret
configured in the dev workflow.

> **Note on engagement choice (substitution caveat).** The task brief
> specifies "the Balsley engagement," but no engagement named "Balsley"
> exists in the dev DB (case-insensitive search across both the repo
> and the live `engagements` table both return empty). The closest real
> Moab engagement is the **Seguin Residence**
> (`engagement_id = f8679f6e-08f3-41a6-a3e8-c576d5cfd76b`,
> "1421 Seguin St, Moab, UT 84532"), which is the substitute used here.
>
> **Why this substitution is equivalent for the BEFORE baseline.** The
> retrieval path used by chat — `POST /api/dev/atoms/retrieve` — is
> purely keyed by `jurisdictionKey`. The engagement is consumed only to
> derive that key via `keyFromEngagement()` (in
> `lib/codes/src/jurisdictions.ts`), which maps an engagement's
> jurisdiction city/state through the `JURISDICTION_KEY_OVERRIDES`
> table and returns `grand_county_ut` for any `moab|ut` or
> `grand county|ut` engagement. The Balsley
> engagement, if it existed, would resolve to the *same* key as Seguin,
> and so would return the *same* atom set. To prove this empirically I
> ran the probe twice with the same query string — once by
> `engagementId = f8679f6e-…` (Seguin) and once with the resolver
> short-circuited by passing `jurisdiction=grand_county_ut` directly —
> and **both returned byte-identical top-3 results** (same atom IDs,
> same scores, same order). Therefore the BEFORE baseline below is
> correct for whatever Moab engagement Phase 4 ultimately compares
> against, including a future "Balsley" engagement if one is created.

### Query

```
"what are the setbacks for this property"
```

### Top-3 results (vector mode, cosine similarity)

| Rank | Score   | Code book | Section ref       | Body preview |
|------|---------|-----------|-------------------|--------------|
| 1    | 0.2841  | IWUIC     | `CHAPTER 5#part2` | `…504.10 Vents.Attic ventilation openings, foundation or under-floor vents, or other ventilation…` |
| 2    | 0.2742  | IWUIC     | `SECTION 607#part7` | `…anting and cultivation. Check with your local Extension office or State Department of Agriculture…` |
| 3    | 0.268   | IWUIC     | `SECTION 607#part8` | `…CLASS 1 IGNITION-RESISTANT CONSTRUCTION. . . 504 Detached accessory…` |

### Verdict

**Results are wildland-fire-only and all under 0.6.** Every match is from
the IWUIC 2006 book; zero atoms came from a zoning / setback / lot
dimension source because no such atom exists in the corpus. The 0.6
retrieval threshold (per `lib/codes/src/retrieval.ts`) filters all three
out, so chat would currently answer the setbacks question from model
knowledge alone — exactly the gap the sprint is meant to close.

The sprint premise is confirmed. Phase 2 should proceed.

For reference, current corpus state:

```
bastrop_tx       :  189 atoms
grand_county_ut  :   75 atoms  (IRC R301.2(1) HTML + IWUIC 2006 PDF only)
```

---

## 2. Path A — Municode (rejected: not available)

Per `lib/codes-sources/MUNICODE_API_NOTES.md`, the resolution chain
starts with `GET /Clients/name?clientName=…&stateAbbr=…`. I probed three
plausible names; all returned **HTTP 204 No Content**:

```
GET /Clients/name?clientName=Grand%20County&stateAbbr=UT  → 204
GET /Clients/name?clientName=Grand%20County%20Utah&…      → 204
GET /Clients/name?clientName=Moab&stateAbbr=UT            → 204
GET /Clients/name?clientName=Castle%20Valley&stateAbbr=UT → 204
```

To rule out a name spelling miss, I pulled the full UT client roster:

```
GET /Clients/StateID/44   → 200 OK, 84 clients
```

The 84-entry list contains every UT municipality Municode hosts. None
matches Grand County, Moab, Castle Valley, or any nearby jurisdiction.
The closest UT counties on Municode are Cache, Davis, Iron, Salt Lake,
Summit, Uintah, Utah, Wasatch, and Weber — Grand County is absent.

**Conclusion:** Municode does not host the Grand County Land Use Code.
Path A is unavailable. No `clientID`/`productId`/`codeID` exists to
record.

---

## 3. Path B — direct PDF on grandcountyutah.net (deviation: code is not a PDF)

The task assumed the canonical fallback would be a PDF on
`grandcountyutah.net`'s Planning & Zoning page. Reality:

1. The County's `/SiteMap` lists `https://www.grandcountyutah.net/927/Land-Use-Code`.
2. That page **301-redirects** off the County site entirely:
   ```
   GET https://www.grandcountyutah.net/927/Land-Use-Code
     → 301 → https://www.codepublishing.com/UT/GrandCounty/
   ```
3. The destination is a **chapter-by-chapter HTML codification** hosted by
   Code Publishing Co. (a General Code Inc. brand), **not a single PDF**.
4. The County does host one zoning-related PDF — `/486/Zoning-Map-PDF`,
   the parcel-level zoning map — but a map image is not a substitute for
   the textual Land Use Code and is out of scope for atomization.

So Path B as originally framed (single text-extractable PDF on the
County site) does not exist. The actual Path B is the codepublishing.com
HTML codification, which I'm calling **Path B′** below to make the
deviation from the task brief explicit.

---

## 4. Path B′ — codepublishing.com HTML (chosen)

### Source

- Canonical entry point: `https://www.codepublishing.com/UT/GrandCounty/`
- Title: **Grand County Land Use Code**
- Linked from the County via `https://www.grandcountyutah.net/927/Land-Use-Code`
- Hosting platform: Code Publishing Co. / General Code Inc.
- Content type: static HTML pages, one per article
- Edition string: codepublishing.com does not surface a single
  supplement-style version label like Municode does. Per-section
  revision dates are inlined as headings (`Article 1 General Provisions
  Revised 3/21`, `2.11 RC, Resort Commercial District Revised 6/19`,
  `2.12 RS, Resort Special District Revised 3/21`). The most recent
  revision marker observed in the TOC scan is **3/21 (March 2021)**, so
  the working edition string for the warmup seed is **`Land Use Code
  (rev. 3/21)`**. Phase 2 should re-confirm this at ingestion time and
  capture the per-section revision marker into atom metadata for
  citation accuracy.

### Text-extractability

Confirmed extractable. All 12 pages were fetched with `curl` and parsed
with stdlib regex over `<h3>` / `<h4>` tags successfully — the pages are
plain server-rendered HTML, not a JS SPA. (The County's Planning &
Zoning page itself is JS-rendered, but that doesn't matter — the
codification it links to is not.)

Per-page sizes (raw HTML bytes), from a clean GET pass:

```
LUC01  General Provisions               20,065 b
LUC02  Zoning Districts                 49,322 b
LUC03  Use Regulations                 551,049 b   ← giant table-of-uses
LUC04  Special Purpose & Overlay       192,627 b
LUC05  Lot Design Standards             92,850 b
LUC06  General Development Standards   246,286 b
LUC07  Subdivision Standards            55,365 b
LUC08  Decision-making Bodies           16,974 b
LUC09  Administration & Procedures     171,201 b
LUC10  Definitions                     127,127 b
LUCAddA Appendix A                       2,175 b
LUCAddB Appendix B                       2,251 b
                                    -----------
                                    ~1.53 MB raw HTML
```

### Crawl posture

`https://www.codepublishing.com/robots.txt` (verified during recon)
disallows `/cgi-bin/`, `/CPC/`, `/dtSearch/`, `/search/`, `*.pdf$`,
`*_*.html$` (note the underscore — our targets `GrandCountyLUC01.html`,
`…LUCAddA.html` have **no underscore** and are allowed). The
`/UT/GrandCounty/html/…` path is not blocked. Twelve sequential GETs
spaced ≥ 1 s with a Hauska-CodeAtoms User-Agent is well within polite
crawler norms; legal posture mirrors `MUNICODE_API_NOTES.md` (municipal
code is a government work; codification by a third-party vendor does
not extend copyright over the enacted text per *Public.Resource.Org v.
ASTM*, 896 F.3d 437).

### Path decision

> **Path B′ wins by elimination.** Path A (Municode) is not available.
> Path B as originally framed (PDF on County site) does not exist.
> Path B′ (codepublishing.com HTML) is the only ingestable source for
> Grand County zoning text.

---

## 5. Sizing the work

### Section count at H3 ("section level")

The sprint locks atomization at section level, which on this code maps
to the H3 heading level (e.g., `2.3 SLR, Small Lot Residential
District`). Counts from a static parse of the 12 article HTML files:

| Article | Title                              | H3 sections | H4 subsections |
|---------|------------------------------------|-------------|----------------|
| 1       | General Provisions                 | 12          | 8              |
| 2       | Zoning Districts                   | 14          | 55             |
| 3       | Use Regulations                    | 4           | 20             |
| 4       | Special Purpose & Overlay Districts| 9           | 75             |
| 5       | Lot Design Standards               | 6           | 13             |
| 6       | General Development Standards      | 15          | 79             |
| 7       | Subdivision Standards              | 11          | 40             |
| 8       | Decision-making Bodies             | 4           | 11             |
| 9       | Administration & Procedures        | 17          | 87             |
| 10      | Definitions                        | 2           | 9              |
| AddA    | Appendix A                         | 0           | 0              |
| AddB    | Appendix B                         | 0           | 0              |
| **Σ**   |                                    | **94**      | **397**        |

**Base estimate: ~94 atoms at section granularity.** H4 subsections fold
into their parent H3's body (consistent with how Bastrop's Municode
adapter chunks one atom per `Doc`). Compared to the Bastrop UDC baseline
of **189 atoms**, Grand County is roughly **half** the scale.

### Over-cap splits (the realistic upper bound)

`embedTexts()` clamps each input at 32 000 chars (~8000 tokens) before
hitting the OpenAI cap. The IWUIC PDF parser already encodes a tighter
4 000-char chunk cap (`MAX_CHARS_PER_CHUNK` in `grandCountyPdf/parser.ts`)
to keep individual atoms bite-sized for retrieval; whatever Phase 2
adapter we build should adopt the same convention.

Article 3 (Use Regulations) has only 4 H3 sections in 551 KB of HTML
— after stripping markup, plain text is roughly 200 KB across just 4
sections, i.e., ~50 KB per section, which exceeds the 4 000-char cap by
~12×. Articles 4, 6, and 9 will also have over-cap H3 sections. Applying
the same `#partN` splitting heuristic the IWUIC adapter uses, the
realistic atom count is **~120–150 atoms** in the corpus after splits.

Two small appendices contribute zero H3s on their own pages
(LUCAddA.html and LUCAddB.html are 2 KB each and contain only a
forwarding link). They can be skipped or treated as a single
catch-all atom each — negligible.

### Embedding cost

`lib/codes/src/embeddings.ts` is the source of truth: the configured
model is **`text-embedding-3-small`**, 1536 dimensions. (The sprint
prompt's parenthetical reference to `voyage-3` is stale and was ignored
per the task instructions.)

OpenAI list price for `text-embedding-3-small`: **$0.02 per 1 M tokens**.

Token estimate:

- Total raw HTML across 12 articles: ~1.53 MB
- Markup is roughly 60 % of HTML byte-size for this code; plain text
  body ≈ 600–650 KB
- At ~4 chars/token (OpenAI rule of thumb), ≈ **150 K tokens** total
  for the whole code

Cost: 150 000 × $0.02 / 1 000 000 ≈ **$0.0030**. Including a small
margin for re-embedding during dev, well under one cent. Trivial.

### Warmup duration

The orchestrator (`lib/codes/src/orchestrator.ts`) reports timestamps in
ISO-8601 on the warmup-status row, with integer queue counts
(`pending` / `processing` / `completed` / `failed` / `total`).
Bastrop's most recent completed warmup, queried via
`GET /api/codes/warmup-status/bastrop_tx`:

```json
{
  "state": "completed",
  "completed": 30, "total": 30, "failed": 0,
  "startedAt":   "2026-04-28T19:31:59.627Z",
  "completedAt": "2026-04-28T19:33:19.816Z"
}
```

That is **80 s wall time for 30 TOC queue rows producing 189 atoms**
— dominated by the Municode 1.5 s + jitter politeness gap (30 × ~2.5 s).

For Path B′ Grand County, with one HTTP fetch per article (12 fetches),
spaced ≥ 1 s for politeness, plus one batched embedding call:

- 12 chapter GETs × ~1.0 s ≈ 12 s
- 1 batched OpenAI embeddings call for ~150 atoms ≈ 5–10 s
- DB upserts ≈ negligible

**Estimated warmup duration: ~30 s, conservatively ~60 s for first
warmup.** Subsequent warmups dedupe via the `(source_id, section_url)`
unique index → effectively instant.

---

## 6. Structural quirks the parser will need to handle

A tour of the article TOCs surfaces these patterns; the column on the
right is whether the existing Bastrop-tuned `municode/parser.ts` covers
the case (it does not — Bastrop parser consumes a Municode JSON
envelope, not HTML, so a brand-new `codePublishingHtml` parser is
needed regardless).

| Quirk                                                                 | In scope for existing parsers? |
|-----------------------------------------------------------------------|---------------------------------|
| Per-district setback tables nested under H4 "District Standards" (Art. 2 has 12 districts each with a `2.X.4 District Standards` block) | New parser. The atom body for `2.3 SLR …` should include 2.3.1–2.3.4 inline so a setback retrieval hit on "SLR setback" returns the actual table. |
| Article 3 single-H3 mega-section (Use Regulations) — one H3 wraps a giant table of 100s of permitted uses | New parser + `#partN` over-cap splitting (mirror `grandCountyPdf/parser.ts`'s `MAX_CHARS_PER_CHUNK = 4000` heuristic). |
| HTML tables within a section body (district standards, dimensional standards, parking ratios) | New parser. Strip-to-text via `cheerio` `.text()` is sufficient (Bastrop's `htmlToPlainText` does the same); table semantics will not survive but the dimensional values will. |
| Inline revision markers in section headings (`Revised 3/21`, `Revised 6/19`) | New parser must capture and stash these into atom `metadata.revision` so citations stay accurate when the County re-codifies. |
| Cross-references to Utah state code via `//www.codepublishing.com/cgi-bin/uca.pl?cite=…` | New parser. Treat as opaque links; no need to resolve. Strip to plain text. |
| Definitions article (Article 10) is two H3s with all defined terms under H4s | New parser. Folding everything into the two H3 atoms may make retrieval awkward ("what is a 'lot of record'" → fuzzy hit on a giant atom). Acceptable for Phase 2 within the section-granularity rule; Phase 5 could revisit. |
| Two appendix pages (LUCAddA, LUCAddB) at 2 KB each — basically empty stubs that link to PDFs | Skip in Phase 2. Note the omission in atom metadata so a future task can add PDF appendices if needed. |

None of these quirks require changes to the existing
`municode/parser.ts` (Municode is not in scope) or
`grandCountyPdf/parser.ts` (the IWUIC PDF flow is unaffected).

The Phase 2 adapter should ship as a sibling to those two:
`lib/codes-sources/src/codePublishingHtml/` (or
`grandCountyLanduseHtml/` if a more jurisdiction-scoped name is
preferred), with its own `parser.test.ts` driven from a captured
fixture of one representative article (LUC02 is a good candidate —
small, table-heavy, and contains the highest-value setback content).

---

## 7. Jurisdiction key & source-registry decision

**Recommendation: extend the existing `grand_county_ut` entry with a
third book** (no new jurisdiction key).

Current shape in `lib/codes/src/jurisdictions.ts`:

```ts
grand_county_ut: {
  key: "grand_county_ut",
  displayName: "Grand County, UT (Moab)",
  books: [
    { codeBook: "IRC_R301_2_1", sourceName: "grand_county_html", … },
    { codeBook: "IWUIC",        sourceName: "grand_county_pdf",  … },
  ],
}
```

Phase 2 adds a third entry:

```ts
{
  label: "Grand County, UT — Land Use Code (rev. 3/21)",
  codeBook: "LAND_USE",
  edition: "Land Use Code (rev. 3/21)",
  sourceName: "grand_county_landuse_html",
}
```

The new `code_atom_sources` row Phase 2 must add to
`REQUIRED_CODE_ATOM_SOURCES` in `lib/codes/src/sourceRegistry.ts`:

```ts
{
  sourceName: "grand_county_landuse_html",
  label: "Grand County, UT — Land Use Code (HTML, codepublishing.com)",
  sourceType: "html",
  licenseType: "public_record",
  baseUrl: "https://www.codepublishing.com/UT/GrandCounty/",
  notes:
    "Per-article HTML on Code Publishing Co. (General Code Inc.); " +
    "linked from grandcountyutah.net/927/Land-Use-Code via 301. " +
    "Section-level atoms (~94 base, ~120–150 after over-cap splits). " +
    "Most recent revision marker observed: 3/21.",
}
```

### Why not a new key?

A separate key (e.g. `grand_county_ut_landuse`) would force every
caller — `keyFromEngagement`, the warmup orchestrator, the Code
Library UI, the chat retrieval path — to know about two distinct
jurisdiction identities for the same county. Three concrete downsides:

1. **Retrieval split-brain.** The chat retrieval path keys atoms by
   `jurisdictionKey`. A separate key would mean a Moab engagement's
   chat call retrieves *either* IRC/IWUIC *or* zoning, never both,
   unless we union-query both keys — a bigger change than just adding
   a book.
2. **Key resolution.** `keyFromEngagement()` returns one key per
   engagement. Splitting Grand County would force a second resolver
   pass or a multi-value return, both of which ripple through chat
   prompt assembly.
3. **No actual reason to keep them separate.** All three books cover
   the same physical jurisdiction; the only thing distinguishing them
   is the source URL, which is already captured per-atom on
   `code_atoms.sourceUrl`.

The book-vs-key choice exactly mirrors the existing IRC + IWUIC
pairing: same jurisdiction, multiple books, distinct `sourceName`s.
Phase 2 should follow the same pattern.

---

## 8. Final recommendation

> **Proceed with Path B (in its actual form — HTML on
> codepublishing.com, "Path B′" — because Path A Municode is
> unavailable and the briefed Path B PDF on grandcountyutah.net does
> not exist) for the Grand County Land Use Code.** Add
> `codeBook: "LAND_USE"` / `sourceName: "grand_county_landuse_html"` as
> a third book under the existing `grand_county_ut` jurisdiction. Plan
> for ~94 base atoms at H3 section granularity (~120–150 after over-cap
> `#partN` splits), **~$0.003** embedding cost on
> `text-embedding-3-small`, ~30–60 s warmup wall-time. Phase 2 must
> build a new `codePublishingHtml` adapter
> (`lib/codes-sources/src/codePublishingHtml/`) plus a `parser.test.ts`
> driven from a captured LUC02 fixture; no changes to the Municode or
> IWUIC PDF adapters are anticipated.
