import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListCodeJurisdictions,
  getListCodeJurisdictionsQueryKey,
} from "@workspace/api-client-react";
import { BookOpen, ChevronRight } from "lucide-react";

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

const MAX_JURISDICTIONS = 4;

export function CodeLibraryDashboardSection() {
  const { data: jurisdictions, isLoading } = useListCodeJurisdictions({
    query: {
      queryKey: getListCodeJurisdictionsQueryKey(),
      refetchInterval: 5000,
    },
  });

  const visible = useMemo(
    () => (jurisdictions ?? []).slice(0, MAX_JURISDICTIONS),
    [jurisdictions],
  );

  const totalAtoms = useMemo(
    () => (jurisdictions ?? []).reduce((a, j) => a + j.atomCount, 0),
    [jurisdictions],
  );

  return (
    <section
      className="cockpit-dashboard-section"
      data-testid="dashboard-code-section"
      id="dashboard-code"
    >
      <header className="cockpit-dashboard-section-head">
        <div>
          <h2 className="cockpit-dashboard-section-title">
            <BookOpen size={16} aria-hidden className="sc-accent-cyan" />
            Code library
          </h2>
          <p className="cockpit-dashboard-section-sub">
            {isLoading
              ? "Loading jurisdictions…"
              : `${jurisdictions?.length ?? 0} jurisdictions · ${totalAtoms} atoms`}
          </p>
        </div>
        <Link
          href="/code-library"
          className="cockpit-dashboard-section-link"
          data-testid="dashboard-code-open-full"
        >
          Full library
          <ChevronRight size={14} aria-hidden />
        </Link>
      </header>

      <div className="cockpit-dashboard-code-grid">
        {visible.map((j) => (
          <Link
            key={j.key}
            href={`/code-library?jurisdiction=${encodeURIComponent(j.key)}`}
            className="cockpit-dashboard-code-card"
            data-testid={`jurisdiction-card-${j.key}`}
          >
            <div className="cockpit-dashboard-code-card-name">{j.displayName}</div>
            <div className="cockpit-dashboard-code-card-stats">
              <span>{j.atomCount} atoms</span>
              <span>{j.books.length} books</span>
            </div>
            <div className="cockpit-dashboard-code-card-meta">
              {relativeTime(j.lastFetchedAt)}
            </div>
          </Link>
        ))}
      </div>

      {!isLoading && (jurisdictions?.length ?? 0) === 0 && (
        <p className="cockpit-dashboard-empty sc-prose opacity-70">
          No jurisdictions configured yet.
        </p>
      )}
    </section>
  );
}
