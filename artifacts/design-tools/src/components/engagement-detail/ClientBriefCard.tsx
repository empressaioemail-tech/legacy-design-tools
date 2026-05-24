import { MessageSquareText } from "lucide-react";
import type { EngagementDetail } from "@workspace/api-client-react";
import {
  getClientBrief,
  intakeSourceLabel,
  type EngagementWithClientBrief,
} from "../intake/clientBriefTypes";
import { SourceChip } from "../cockpit/QualityChips";

export function ClientBriefCard({
  engagement,
}: {
  engagement: EngagementDetail;
}) {
  const brief = getClientBrief(engagement as EngagementWithClientBrief);
  if (!brief) return null;

  const hasNotes = !!brief.clientNotes?.trim();

  return (
    <section
      className="sc-card client-brief-card"
      data-testid="client-brief-card"
      aria-label="Client brief"
    >
      <header className="client-brief-head">
        <MessageSquareText size={16} aria-hidden className="client-brief-icon" />
        <div>
          <h3 className="client-brief-title">Client brief</h3>
          <p className="client-brief-sub sc-meta">
            Notes and contact captured when this project was started.
          </p>
        </div>
        {brief.intakeSource ? (
          <SourceChip
            kind="INTAKE"
            label={intakeSourceLabel(brief.intakeSource)}
          />
        ) : null}
      </header>

      <dl className="client-brief-meta">
        {brief.clientName ? (
          <div>
            <dt>Client / firm</dt>
            <dd>{brief.clientName}</dd>
          </div>
        ) : null}
        {brief.clientEmail ? (
          <div>
            <dt>Contact</dt>
            <dd>
              <a href={`mailto:${brief.clientEmail}`}>{brief.clientEmail}</a>
            </dd>
          </div>
        ) : null}
      </dl>

      {hasNotes ? (
        <div className="client-brief-notes">
          <span className="sc-label">Client notes</span>
          <p className="client-brief-notes-body">{brief.clientNotes}</p>
        </div>
      ) : (
        <p className="client-brief-empty sc-meta">
          No free-form notes were captured at intake.
        </p>
      )}
    </section>
  );
}
