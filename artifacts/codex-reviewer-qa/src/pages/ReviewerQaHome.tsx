/**
 * Codex Reviewer QA — Phase 1 scaffold placeholder page.
 *
 * This artifact is the reviewer-side QA-readiness surface for Codex 1b,
 * decided in `_decisions/2026-05-21_codex_reviewer_qa_surface_location.md`
 * (CDX-Phase1-1) — deliberately a separate artifact from `plan-review`
 * (the architect-side window) and `qa` (the test harness).
 *
 * The reviewer surface proper is Phase 2 of `48_codex_program_plan.md`
 * and a later dispatch. This page is the routable placeholder that
 * marks the Phase 1 scaffold complete.
 */

/** Phase 2 reviewer surfaces, per `48_codex_program_plan.md`. */
const PHASE_2_SURFACES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "CDX-3", label: "One-click AI review pass" },
  { id: "CDX-4", label: "Finding accept / edit / reject loop" },
  { id: "CDX-5", label: "Jurisdiction switcher" },
  { id: "CDX-9", label: "Comment-letter auto-draft" },
];

export default function ReviewerQaHome() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <section
        style={{
          maxWidth: 560,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <span
          style={{
            alignSelf: "flex-start",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            padding: "3px 8px",
            borderRadius: 4,
            background: "var(--info-dim)",
            color: "var(--info-text)",
          }}
        >
          Phase 1 scaffold
        </span>

        <h1 style={{ fontSize: 28, margin: 0 }}>Codex Reviewer QA</h1>

        <p
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Reviewer-side QA-readiness surface for Codex 1b. This artifact
          is intentionally separate from <code>plan-review</code> (the
          architect-side window) and <code>qa</code> (the test harness),
          per decision{" "}
          <code>2026-05-21_codex_reviewer_qa_surface_location</code>.
        </p>

        <p
          style={{
            margin: 0,
            color: "var(--text-muted)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          The scaffold is routable and building. The reviewer surface
          itself lands in Phase 2:
        </p>

        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {PHASE_2_SURFACES.map((surface) => (
            <li
              key={surface.id}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                fontSize: 13,
                color: "var(--text-secondary)",
              }}
            >
              <code
                style={{
                  fontFamily: '"IBM Plex Mono", monospace',
                  color: "var(--text-muted)",
                }}
              >
                {surface.id}
              </code>
              <span>{surface.label}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
