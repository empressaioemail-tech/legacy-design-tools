/** Client context captured at intake — returned on EngagementDetail when present. */
export interface ClientBrief {
  clientName: string | null;
  clientEmail: string | null;
  clientNotes: string | null;
  intakeSource: string | null;
  capturedAt: string | null;
}

export type EngagementWithClientBrief = {
  applicantFirm?: string | null;
  clientBrief?: ClientBrief | null;
};

export function getClientBrief(
  engagement: EngagementWithClientBrief,
): ClientBrief | null {
  if (engagement.clientBrief) return engagement.clientBrief;
  const name = engagement.applicantFirm?.trim();
  if (!name) return null;
  return {
    clientName: name,
    clientEmail: null,
    clientNotes: null,
    intakeSource: null,
    capturedAt: null,
  };
}

const INTAKE_SOURCE_LABELS: Record<string, string> = {
  link: "Linked URL",
  file: "Uploaded file",
  paste: "Pasted text",
  email: "Forwarded email",
};

export function intakeSourceLabel(source: string | null | undefined): string {
  if (!source) return "Manual entry";
  return INTAKE_SOURCE_LABELS[source] ?? source;
}
