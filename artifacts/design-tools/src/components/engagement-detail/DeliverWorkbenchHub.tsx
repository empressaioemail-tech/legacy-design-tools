import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Layers,
  Mail,
  Presentation,
} from "lucide-react";
import type { TabId } from "./urlState";
import { DEMO_DELIVER_WORKBENCH_BLOCKS, isDemoSeedEnabled } from "../../demo/seed";

const ICONS = {
  presentations: Presentation,
  "deliverable-letters": Mail,
  "detail-callouts": Layers,
  "product-specs": FileText,
  renders: ImageIcon,
} as const;

function statusLabel(status: string): string {
  switch (status) {
    case "needs-you":
      return "Needs you";
    case "in-progress":
      return "In progress";
    case "ai-flag":
      return "AI flagged";
    default:
      return "Ready";
  }
}

export function DeliverWorkbenchHub({
  onSelectTab,
}: {
  onSelectTab: (tab: TabId) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  if (!isDemoSeedEnabled()) return null;

  return (
    <section
      className="cockpit-deliver-workbench"
      data-testid="deliver-workbench-hub"
      aria-label="Deliverables workbench"
    >
      <button
        type="button"
        className="cockpit-deliver-workbench-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="cockpit-deliver-workbench-toggle-label">Deliverables workbench</span>
        <span className="cockpit-deliver-workbench-toggle-meta">
          Stacked overview · jump to any lane
        </span>
        <ChevronDown
          size={18}
          className={expanded ? "cockpit-inbox-chevron-open" : ""}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div className="cockpit-deliver-workbench-blocks">
          {DEMO_DELIVER_WORKBENCH_BLOCKS.map((block) => {
            const Icon = ICONS[block.segment];
            return (
              <button
                key={block.id}
                type="button"
                className="cockpit-deliver-workbench-block"
                data-status={block.status}
                data-testid={`deliver-workbench-${block.id}`}
                onClick={() => onSelectTab(block.segment)}
              >
                <div className="cockpit-deliver-workbench-block-icon">
                  <Icon size={16} aria-hidden="true" />
                </div>
                <div className="cockpit-deliver-workbench-block-body">
                  <div className="cockpit-deliver-workbench-block-title">{block.title}</div>
                  <div className="cockpit-deliver-workbench-block-desc">{block.description}</div>
                </div>
                <div className="cockpit-deliver-workbench-block-meta">
                  <span
                    className="cockpit-deliver-workbench-status"
                    data-status={block.status}
                  >
                    {statusLabel(block.status)}
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
