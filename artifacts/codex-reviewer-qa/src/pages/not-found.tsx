/**
 * Codex Reviewer QA — catch-all 404. The scaffold has a single route
 * (`/`); Phase 2 routes register alongside it in `App.tsx`.
 */
export default function NotFound() {
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
      <div
        style={{
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>404 — Page not found</h1>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>
          This route is not part of the Codex Reviewer QA scaffold yet.
        </p>
      </div>
    </main>
  );
}
