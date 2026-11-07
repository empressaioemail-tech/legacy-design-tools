/**
 * P-270 (OPS-24 scope X11) — was this setback citation's effective date
 * readable AT SOURCE, and what does the surface say when it was not.
 *
 * THE RULING THIS IMPLEMENTS. MOST-CURRENT SOURCE WINS (operator 2026-09-11,
 * `_decisions/2026-09-11_setback_source_most_current_wins.md`): for setbacks
 * and every dimensional rule the source with the most recent effective date
 * supplies the value; dates are read AT SOURCE, never assumed from source
 * kind; and "an unreadable date produces a conflict row, never a silent
 * pick." The first two clauses are built in this repo
 * (`authoritativeSetbackSource.ts` reads `table.effectiveDate` /
 * `sourceVintage` through `@empressaio/setback-corpus/resolve` and serves
 * `effectiveDate` + `dateBasis`). This module is the third: before it, the
 * DRAWN envelope served `citationUrl` (`derive.ts`) with no date beside it
 * and no statement when no date could be read, so a customer could not tell a
 * rule from this year from one from 2011. That is a silent pick in the place
 * a customer actually reads.
 *
 * WHY ONE MODULE. Three sites in this repo touched the same decision and none
 * of them agreed: `derive.ts` composed the drawn envelope's citation from the
 * codified table's `citation_url` and never read the table's own
 * `effectiveDate` field at all (the literal `never-looked` state);
 * `setbackRulesFactFromParcelRecord.ts` read a companion row's `effectiveDate`
 * and collapsed a missing-or-unreadable value into a bare `null` with no
 * state; and `brokerageResearchAreaContext.ts` printed `- Source: <url>` with
 * no vintage line. This is the ONE place that decides; the callers hand it a
 * source date read and a citation URL and then render what it returns.
 *
 * WHY IT DOES NOT RE-IMPLEMENT THE DATE READ. `authoritativeSetbackSource.ts`
 * already reads table dates through the corpus's own
 * `dateFromTableEffectiveDate`, and the corpus's `SetbackDateBasis` is the
 * vocabulary that decides whether a candidate's date is readable (its
 * `"unreadable"` member is first-class and documented as "never a placeholder
 * date like 1970-01-01" — the same stance this module takes). So the table
 * read here CALLS that reader rather than parsing again: two date parsers on
 * one path is how a most-current-wins comparison ends up comparing two
 * different notions of "a date". What this module adds is only what the
 * corpus's vocabulary cannot express: the difference between a date field
 * that is ABSENT at source and one that is present and unparseable.
 *
 * THE STATES (dispatch item 3, extended by P-354). "Absent at source",
 * "present but unparseable", "never looked for" and "read, but not yet in
 * effect" are four different situations and none of them is the others, so
 * they are members of one union and never one boolean. A FIFTH value is
 * deliberately NOT here: see `stateFromWireBasis` for the one wire on which
 * the first two cannot be told apart, which is bounded and named rather than
 * papered over with a new member.
 *
 * THE TWO AUDIENCES. The customer gets ONE sentence, identical in both repos
 * (see `SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE`), because three causes
 * phrased three ways is three chances for hauska-map and legacy-design-tools
 * to drift. The machine gets the distinct `state`, which is the member an
 * instrument or a future writer switches on. The row carries both, so neither
 * audience is guessed at.
 *
 * NEVER DEFAULT THE DATE (dispatch item 4). There is no `1970-01-01`, no
 * "today", no `Date.now()` and no reuse of a cell's write vintage anywhere on
 * this path. A defaulted date would enter a most-current-wins comparison and
 * silently win or lose it, which is the worst available outcome, so the
 * refusal IS the behaviour.
 */

import {
  dateFromTableEffectiveDate,
  type SetbackDateBasis,
} from "@empressaio/setback-corpus/resolve";

/**
 * How a setback citation's effective date was established, read AT SOURCE.
 *
 * `read` is the only member that means a date is on the wire. The other three
 * are the unreadable causes, kept apart on purpose:
 *
 * - `unreadable-absent-at-source` — the source was consulted and its own
 *   date-bearing field carries no date: the key is missing, or it is present
 *   and explicitly null. The source states no date.
 * - `unreadable-unparseable` — the source's date-bearing field EXISTS and is
 *   populated with something this module will not accept as a date. A
 *   different defect with a different fix (a bad value in a good field), and
 *   NOT the same as the source having no date.
 * - `unreadable-never-looked` — no date-bearing field was consulted at all.
 *   This is a statement about the RESOLVER, not about the source, and it is
 *   the state the drawn-envelope path was in until this lane: `derive.ts`
 *   composed `citationUrl` out of the district row and never had a date read
 *   in it.
 * - `future-effective` — P-354 (2026-09-18). The date WAS read, it is a real
 *   date, and it is LATER than the day being served: the rule is adopted but
 *   not yet in force, and the operator ruled it served anyway (A-218,
 *   Georgetown: adopted 2026-08-11, effective 2026-11-01). This is not
 *   unreadable and it is not `read`; conflating it with either is the bug this
 *   member exists to kill. Before it, a future-dated row hit `read` and the
 *   envelope printed the date as though it were already in force.
 */
export type SetbackDateReadState =
  | "read"
  | "future-effective"
  | "unreadable-absent-at-source"
  | "unreadable-unparseable"
  | "unreadable-never-looked";

/** The three unreadable causes. Never `read`, never `future-effective`. */
export type SetbackDateUnreadableState = Exclude<
  SetbackDateReadState,
  "read" | "future-effective"
>;

/** The wire token the conflict row below is published under (VOCABULARY). */
export const SETBACK_CITATION_VINTAGE_TOKEN =
  "setback-citation-vintage-unreadable" as const;

/**
 * P-354. The token a FUTURE-EFFECTIVE citation's declaration is published
 * under -- deliberately NOT the unreadable token, because a reader that
 * switches on `kind` must not treat "adopted, takes effect later" as "we could
 * not tell".
 */
export const SETBACK_CITATION_FUTURE_EFFECTIVE_TOKEN =
  "setback-citation-future-effective" as const;

/**
 * THE exact customer sentence. Byte-identical to hauska-map's
 * `apps/property-explorer/api/_lib/setback-citation-vintage.ts` copy; a test
 * in EACH repo pins the literal so a drift is a failing test rather than a
 * silent difference. Promotion into `@empressaio/atom-contract/display` (the
 * canon's one vocabulary module) is this lane's leave_behind item 1 — this
 * lane cannot publish that package.
 *
 * It is ONE sentence for all three unreadable causes and names the
 * consequence rather than the cause: "undated" and "not as current" are true
 * of every one of them, and the machine-readable `state` on the same row is
 * where the cause lives. Verify-with-the-city is the same instruction the
 * envelope's own geometry disclosure already gives ("verify with survey +
 * city"), so the surface does not teach two different next steps.
 */
export const SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE =
  "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.";

/**
 * P-354. THE exact sentence for a rule that IS dated and whose date has not
 * arrived. Byte-identical to hauska-map's copy, pinned in both repos' tests for
 * the same reason as the note above. It names BOTH dates and the fact that the
 * rule is served AHEAD of its effective date — the price the operator's A-218
 * ruling attaches to serving Georgetown from the rewrite before 2026-11-01.
 *
 * The adoption date is optional in the sentence and required in the row: a
 * source that states no adoption date yields "Setback rule takes effect
 * <date> ..." rather than an invented adoption date, because the alternative
 * is a fabricated date entering a most-current-wins comparison.
 */
export function setbackFutureEffectiveNote(
  adoptedDate: string | null,
  effectiveDate: string,
): string {
  const adopted = adoptedDate ? `adopted ${adoptedDate}, ` : "";
  return `Setback rule ${adopted}takes effect ${effectiveDate} — the rule is served ahead of its effective date, not as current. Verify with the city.`;
}

/** The terse form the envelope's own citation clause uses, from the same one place. */
export function setbackFutureEffectiveCardMarker(
  adoptedDate: string | null,
  effectiveDate: string,
): string {
  const adopted = adoptedDate ? `adopted ${adoptedDate}, ` : "";
  return `${adopted}takes effect ${effectiveDate}`;
}

/** A read of one source's own date-bearing field. `sourceDate` is only ever a value literally on the source. */
export type SetbackDateRead = {
  sourceDate: string | null;
  state: SetbackDateReadState;
  /**
   * P-354 (2026-09-18). The rule's own adoption date, read at source, when the
   * source carries one. Present only for `future-effective` today (it is what
   * the future-effective sentence names first) and never inferred from the
   * table's vintage or the source kind.
   */
  adoptedDate?: string | null;
};

/**
 * The conflict row. Published on the payload next to the citation it is
 * about, so a reader (human or instrument) that holds the citation can always
 * ask what its vintage is, and never has to parse the disclosure prose to
 * find out.
 */
export type SetbackCitationVintageRow = {
  kind: typeof SETBACK_CITATION_VINTAGE_TOKEN;
  /** Which of the three unreadable causes. Never `"read"` — a readable date is not a conflict. */
  state: SetbackDateUnreadableState;
  /** The source whose date could not be read, as the resolver knows it. */
  sourceLabel: string | null;
  /** The citation that is being served undated — the row is never published without one. */
  citationUrl: string;
  /** The exact sentence every surface prints. Byte-identical across repos. */
  note: string;
};

/**
 * P-354. The declaration published for a rule that IS dated and whose date has
 * not arrived yet — a different thing from the conflict row above, with its
 * own `kind`, so a reader that switches on `kind` cannot confuse "we do not
 * know when this took effect" with "we know exactly when it takes effect, and
 * it has not happened yet".
 */
export type SetbackCitationFutureEffectiveRow = {
  kind: typeof SETBACK_CITATION_FUTURE_EFFECTIVE_TOKEN;
  state: "future-effective";
  /** Read at source from the rule's own adoption record; null if the source states none. */
  adoptedDate: string | null;
  /** The rule's own effective date, later than the day being served. */
  effectiveDate: string;
  sourceLabel: string | null;
  citationUrl: string;
  /** The full sentence, for the disclosure. Byte-identical across repos. */
  note: string;
  /** The terse form the envelope's own citation clause prints after the URL. */
  cardMarker: string;
};

/** Either declaration. A citation carries AT MOST ONE of these. */
export type SetbackCitationVintageDeclaration =
  | SetbackCitationVintageRow
  | SetbackCitationFutureEffectiveRow;

/** No resolver on this path ever consulted a date-bearing field. */
export const NEVER_LOOKED_DATE_READ: SetbackDateRead = {
  sourceDate: null,
  state: "unreadable-never-looked",
};

/**
 * Read one field AT SOURCE. `present` is `true` only when the source's own
 * object HAS the key — the caller must not pre-collapse a missing key with an
 * empty or null value, because those are two of the three states this module
 * exists to keep apart.
 *
 * A key that is present and explicitly `null` reads as `absent-at-source`: the
 * source is stating it carries no date, which is a statement, not a malformed
 * value.
 *
 * `sourceDate` accepts a value only through the corpus's own
 * `parseStrictIsoDate`, reached via `dateFromTableEffectiveDate`, so this
 * module can never disagree with the resolver about what a date is.
 */
export function readSetbackDateAtSource(field: {
  present: boolean;
  value: unknown;
}): SetbackDateRead {
  if (!field.present) {
    return { sourceDate: null, state: "unreadable-absent-at-source" };
  }
  if (field.value === null || field.value === undefined) {
    return { sourceDate: null, state: "unreadable-absent-at-source" };
  }
  const { sourceDate } = dateFromTableEffectiveDate(
    typeof field.value === "string" ? field.value : null,
  );
  return sourceDate
    ? { sourceDate, state: "read" }
    : { sourceDate: null, state: "unreadable-unparseable" };
}

/**
 * Read a codified table's date AT SOURCE: the table's own `effectiveDate`
 * field, and nothing else. An "accessed ..." note in `table.note` records
 * when someone LOOKED, never when the law took effect, and is deliberately
 * not consulted here.
 */
export function readSetbackDateFromTable(table: unknown): SetbackDateRead {
  const rec = table as Record<string, unknown> | null | undefined;
  if (!rec || typeof rec !== "object") {
    return { sourceDate: null, state: "unreadable-absent-at-source" };
  }
  return readSetbackDateAtSource({
    present: Object.prototype.hasOwnProperty.call(rec, "effectiveDate"),
    value: rec.effectiveDate,
  });
}

/**
 * Read the first PRESENT key out of a companion row, at source. The keys are
 * the source's own spellings (`effectiveDate` and the snake_case
 * `effective_date` the `parcel_record` writer uses); the first key that is
 * present wins, so a row carrying both fields with different values yields
 * the first one's state rather than a merged guess.
 *
 * A `null` row is NOT this function's business: whether "no row" means
 * `never-looked` or something else depends on whether the rail was consulted,
 * which only the caller knows, so the caller passes `NEVER_LOOKED_DATE_READ`
 * explicitly. Keeping that decision at the call site is what stops this
 * module from inventing a state it cannot see.
 */
export function readSetbackDateFromRowAtSource(
  row: Record<string, unknown>,
  keys: readonly string[],
  opts: { adoptedKeys?: readonly string[]; asOf?: string } = {},
): SetbackDateRead {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const read = readSetbackDateAtSource({ present: true, value: row[key] });
      if (read.state !== "read") return read;
      const adopted = opts.adoptedKeys ? readAdoptedDateFromRowAtSource(row, opts.adoptedKeys) : null;
      return applyFutureEffectiveState(read, { adoptedDate: adopted, asOf: opts.asOf });
    }
  }
  return { sourceDate: null, state: "unreadable-absent-at-source" };
}

/**
 * P-354 (2026-09-18). The rule's own ADOPTION date, read at source in the same
 * two spellings, and validated through the SAME corpus reader the effective
 * date goes through — not a second parser, because two parsers on one path is
 * how a most-current-wins comparison ends up comparing two notions of "a
 * date". A value the corpus will not accept yields `null`, and the sentence
 * then names the effective date alone rather than an invented adoption date.
 */
/** The source's own spellings for a rule's ADOPTION date. */
export const SETBACK_ADOPTED_DATE_FIELD_KEYS = ["adoptedDate", "adopted_date"] as const;

/**
 * P-354 (2026-09-18). The rule's own ADOPTION date, read at source in the same
 * two spellings, and kept only when it is a real calendar date — see
 * `strictCalendarIsoOrNull` for why the resolver's shape-only tolerance is not
 * inherited for THIS field while it is for the effective date.
 */
export function readAdoptedDateFromRowAtSource(
  row: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    return strictCalendarIsoOrNull(row[key]);
  }
  return null;
}

/** The day being served, read ONCE per call so a resolution cannot straddle midnight. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * P-354. A value this module is willing to reason about ARRIVAL for: strict
 * `yyyy-mm-dd` that is also a real calendar date.
 *
 * THE TWO-QUESTION SEPARATION, which is the whole reason this exists beside the
 * corpus's reader rather than inside it. "Is this a date?" and "has this date
 * arrived?" are different questions with different tolerances:
 *
 * - The corpus's `parseStrictIsoDate` (reached via `dateFromTableEffectiveDate`)
 *   answers the FIRST one SHAPE-ONLY, and that is deliberate: it ORDERS
 *   candidates by date, and `2026-13-99` sorts sensibly among real dates. This
 *   module does not overrule that — the value is still served as the rule's
 *   `effectiveDate`, and no unreadable declaration is made about it, because
 *   calling "undated" a rule the resolver just ranked by its date would be this
 *   rail inventing a second opinion (the ruling pinned in
 *   `setbackRulesFactFromParcelRecord.test.ts`).
 * - The SECOND question has no answer for a value that is not a real calendar
 *   date. Promoting it to `future-effective` would print `takes effect
 *   2026-13-99` — a nonsense date asserted to a customer as a legal fact, and
 *   worse than the silence it replaced. So the promotion requires a real date,
 *   and a shape-only value simply stays `read`: served, ranked, and unremarked.
 *
 * This is NOT a second date parser for the wire — nothing here produces a date
 * the source did not carry, and nothing here rejects a value the resolver
 * accepts. It is a comparability check on a value already read.
 */
function isComparableCalendarDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return false;
  // The round-trip rejects the roll-forward case: `2026-02-31` normalizes to
  // `2026-03-03`, so a string that does not survive normalization was not a
  // date and its "arrival" cannot be reasoned about.
  return new Date(ms).toISOString().slice(0, 10) === raw;
}

/**
 * P-354. Promote a plain `read` to `future-effective` when the date read is
 * LATER than the day being served, carrying the source's own adoption date
 * when one was read. An already-unreadable read passes through untouched, and
 * a read that is in force today passes through untouched — so this is the ONE
 * place the future question is asked, on every wire that reads a date, rather
 * than a state each caller has to remember to compute.
 *
 * `asOf` defaults to today; passing it explicitly is how a test pins the state
 * instead of depending on the wall clock.
 */
export function applyFutureEffectiveState(
  read: SetbackDateRead,
  opts: { adoptedDate?: unknown; asOf?: string } = {},
): SetbackDateRead {
  if (read.state !== "read" || !read.sourceDate) return read;
  if (!isComparableCalendarDate(read.sourceDate)) return read;
  const asOf = opts.asOf ?? todayIso();
  if (read.sourceDate <= asOf) return read;
  const adoptedDate = strictCalendarIsoOrNull(opts.adoptedDate);
  return { sourceDate: read.sourceDate, state: "future-effective", adoptedDate };
}

/**
 * The adoption date, kept only when it is a real calendar date. The resolver
 * never reads this field — nothing orders by it — so requiring it to be real
 * contradicts no ranking decision; and the alternative is a sentence that
 * prints `adopted 2026-13-99` beside an otherwise honest effective date. A
 * value that is not a real date yields `null`, and the sentence then names the
 * effective date alone (see `setbackFutureEffectiveNote`).
 */
function strictCalendarIsoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return isComparableCalendarDate(trimmed) ? trimmed : null;
}

/**
 * The corpus resolver's own basis vocabulary (`SetbackDateBasis`), when a
 * wire carries a basis but no date.
 *
 * BOUNDED, AND NAMED RATHER THAN HIDDEN: the published resolver returns the
 * single string `"unreadable"` for both "the field was absent" and "the field
 * held a value that is not a date", so on a wire that carries only the basis
 * those two cannot be told apart. This module does not invent a fourth member
 * to represent its own ignorance of the wire, and it does not silently pick
 * one of the two: the source's own basis said unreadable, so the honest state
 * is that the source states no readable date
 * (`unreadable-absent-at-source`), and the row's `sourceLabel` carries the
 * basis verbatim so nothing the wire DID say is lost.
 *
 * `basis` absent entirely is the `never-looked` case: nothing on that path
 * consulted a date at all.
 */
export function stateFromWireBasis(basis: string | null | undefined): SetbackDateRead {
  if (!basis) return NEVER_LOOKED_DATE_READ;
  if (basis === "unreadable") {
    return { sourceDate: null, state: "unreadable-absent-at-source" };
  }
  return NEVER_LOOKED_DATE_READ;
}

/**
 * The basis the resolver recorded for a date it could READ, or null when the
 * read did not happen. Exposed so a caller can name the source on the row
 * without re-deriving it from the date string.
 */
export function readableBasisOrNull(
  date: SetbackDateRead,
  basis: SetbackDateBasis | null | undefined,
): SetbackDateBasis | null {
  // P-354: `future-effective` belongs here too — that date was READ at source
  // and its basis is as known as any other. The state differs from `read` in
  // what the date MEANS (not yet in force), not in whether it was readable.
  const readable = date.state === "read" || date.state === "future-effective";
  return readable && basis ? basis : null;
}

/**
 * The declaration, or `null` when there is nothing to declare.
 *
 * `null` in exactly three cases, all of them correct rather than convenient:
 * no citation is being served (there is no citation to qualify); the date was
 * readable AND in force (an in-force dated rule is not a conflict — this is
 * the dispatch's agreeing control, asserted in this module's own test so a
 * change that refuses the readable case fails rather than ships); and nothing
 * will be printed anyway.
 *
 * P-354 (2026-09-18): a `future-effective` read returns the SECOND kind, not
 * `null`. That is the whole change — the envelope used to see `read` here and
 * print `effective 2026-11-01` for a rule that does not have that force yet.
 */
export function setbackCitationVintageRow(input: {
  date: SetbackDateRead;
  citationUrl: string | null | undefined;
  sourceLabel: string | null | undefined;
}): SetbackCitationVintageDeclaration | null {
  const url = typeof input.citationUrl === "string" ? input.citationUrl.trim() : "";
  if (!url) return null;
  if (input.date.state === "read") return null;
  const label =
    typeof input.sourceLabel === "string" && input.sourceLabel.trim()
      ? input.sourceLabel.trim()
      : null;
  if (input.date.state === "future-effective") {
    const effectiveDate = (input.date.sourceDate ?? "").trim();
    // A future-effective read always carries its date; if it somehow does not,
    // fall back to the unreadable declaration rather than print a sentence with
    // a hole in it.
    if (effectiveDate) {
      const adoptedDate = strictCalendarIsoOrNull(input.date.adoptedDate);
      return {
        kind: SETBACK_CITATION_FUTURE_EFFECTIVE_TOKEN,
        state: "future-effective",
        adoptedDate,
        effectiveDate,
        sourceLabel: label,
        citationUrl: url,
        note: setbackFutureEffectiveNote(adoptedDate, effectiveDate),
        cardMarker: setbackFutureEffectiveCardMarker(adoptedDate, effectiveDate),
      };
    }
  }
  return {
    kind: SETBACK_CITATION_VINTAGE_TOKEN,
    state: input.date.state === "future-effective" ? "unreadable-absent-at-source" : input.date.state,
    sourceLabel: label,
    citationUrl: url,
    note: SETBACK_CITATION_VINTAGE_UNREADABLE_NOTE,
  };
}

/**
 * Append the sentence to whatever disclosure the payload already carries.
 * Returns the disclosure unchanged when there is no declaration, so a caller
 * can call this unconditionally and a payload that declares nothing is
 * byte-identical to what it was before this lane.
 */
export function disclosureWithCitationVintage(
  disclosure: string | null | undefined,
  row: SetbackCitationVintageDeclaration | null,
): string | undefined {
  const existing = typeof disclosure === "string" ? disclosure.trim() : "";
  if (!row) return existing ? existing : undefined;
  return existing ? `${existing} ${row.note}` : row.note;
}
