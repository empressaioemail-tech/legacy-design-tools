/**
 * Read-only "Revit binding" section for EngagementDetail.
 *
 * Shows the silent identity backstops the C# add-in uses to recognize a Revit
 * project across renames: the central-model GUID and the document path.
 * Renders nothing when both are null so engagements that have never been
 * touched by the add-in stay visually clean.
 *
 * The GUID is rendered as a truncated monospace pill — the full value is
 * exposed via the `title` attribute (and aria-label) for hover/AT access.
 * The document path is rendered verbatim with `word-break: break-all` so long
 * Windows paths wrap inside their card instead of overflowing it.
 */

interface RevitBindingProps {
  revitCentralGuid: string | null;
  revitDocumentPath: string | null;
}

/**
 * Format a GUID like "12345678-9abc-def0-1234-56789abcdef0" as
 * "12345678…abcdef0". Anything <= 20 chars is returned verbatim — there's
 * nothing to gain from truncating a short value.
 */
function truncateGuid(guid: string): string {
  if (guid.length <= 20) return guid;
  return `${guid.slice(0, 8)}…${guid.slice(-7)}`;
}

export function RevitBinding({
  revitCentralGuid,
  revitDocumentPath,
}: RevitBindingProps) {
  if (!revitCentralGuid && !revitDocumentPath) return null;

  return (
    <div className="sc-card p-4" data-testid="revit-binding">
      <div className="sc-label" style={{ marginBottom: 10 }}>
        REVIT BINDING
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(120px, auto) 1fr",
          rowGap: 8,
          columnGap: 12,
          fontSize: 12,
        }}
      >
        {revitCentralGuid && (
          <>
            <div style={{ color: "var(--text-secondary)" }}>Central GUID</div>
            <div>
              <span
                title={revitCentralGuid}
                aria-label={`Revit central GUID ${revitCentralGuid}`}
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                  background: "var(--bg-input)",
                  padding: "2px 8px",
                  borderRadius: 4,
                  color: "var(--text-primary)",
                  display: "inline-block",
                  letterSpacing: "0.02em",
                }}
              >
                {truncateGuid(revitCentralGuid)}
              </span>
            </div>
          </>
        )}
        {revitDocumentPath && (
          <>
            <div style={{ color: "var(--text-secondary)" }}>Document path</div>
            <div
              title={revitDocumentPath}
              style={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "var(--text-primary)",
                wordBreak: "break-all",
                lineHeight: 1.4,
              }}
            >
              {revitDocumentPath}
            </div>
          </>
        )}
      </div>
      <div
        className="sc-meta"
        style={{ marginTop: 10, opacity: 0.65, fontSize: 11 }}
      >
        These values are managed by the Revit add-in and used silently to
        recognize this project across renames. They aren't editable here.
      </div>
    </div>
  );
}
