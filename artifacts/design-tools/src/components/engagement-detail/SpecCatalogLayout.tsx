import type { ReactNode } from "react";
import { TabHeader } from "../cockpit/TabChrome";

/**
 * Shared list + detail shell for L4/L5 spec catalog tabs.
 */
export function SpecCatalogLayout({
  overline,
  title,
  subtitle,
  testId,
  toolbar,
  list,
  detail,
}: {
  overline: string;
  title: string;
  subtitle: string;
  testId: string;
  toolbar?: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div
      className="spec-catalog-layout flex flex-col flex-1 min-h-0"
      data-testid={testId}
    >
      <TabHeader overline={overline} title={title} subtitle={subtitle} testId={`${testId}-header`} />
      {toolbar ? (
        <div className="spec-catalog-toolbar" data-testid={`${testId}-toolbar`}>
          {toolbar}
        </div>
      ) : null}
      <div className="spec-catalog-main">
        <section className="spec-catalog-list sc-scroll" aria-label={`${title} list`}>
          {list}
        </section>
        <section className="spec-catalog-detail sc-scroll" aria-label={`${title} detail`}>
          {detail}
        </section>
      </div>
    </div>
  );
}
