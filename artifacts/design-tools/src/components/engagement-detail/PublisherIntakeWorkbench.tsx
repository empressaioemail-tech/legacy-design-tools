import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useGetEngagementBriefing,
  getGetEngagementBriefingQueryKey,
  type EngagementDetail,
} from "@workspace/api-client-react";
import { Download, RefreshCw, Sparkles } from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import { PublisherDeliverablePackage } from "./PublisherDeliverablePackage";
import {
  buildPublisherIntakeDraft,
  countAutoFilledFields,
  countRequiredPublisherFields,
  mergePublisherIntakeDraft,
} from "./publisherIntake/buildPublisherIntakeDraft";
import { downloadPublisherIntakeCsv } from "./publisherIntake/exportPublisherIntakeCsv";
import {
  PUBLISHER_ARCHITECTURAL_STYLES,
  PUBLISHER_FOUNDATIONS,
  PUBLISHER_GARAGE_TYPES,
  PUBLISHER_PLAN_FEATURES,
  PUBLISHER_PLAN_PRODUCTS,
  PUBLISHER_PLAN_TYPES,
  PUBLISHER_PORCH_TYPES,
  PUBLISHER_STORY_OPTIONS,
} from "./publisherIntake/exhibitCConstants";
import type {
  PublisherFieldSource,
  PublisherFieldSources,
  PublisherIntakeFieldKey,
  PublisherIntakeForm,
  PublisherIntakeRoomRow,
} from "./publisherIntake/types";
import type { TabId } from "./urlState";
import type {
  EngagementPackageRecord,
  PackageFormSnapshot,
  PackageSelection,
} from "./packages/types";

const STORAGE_PREFIX = "publisher-intake-v1:";

function storageKey(engagementId: string): string {
  return `${STORAGE_PREFIX}${engagementId}`;
}

function loadPersistedFromPackage(
  formSnapshot: PackageFormSnapshot | null | undefined,
): { form: PublisherIntakeForm; sources: PublisherFieldSources } | null {
  const raw = formSnapshot?.publisherIntake;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!o.form || typeof o.form !== "object") return null;
  return {
    form: o.form as PublisherIntakeForm,
    sources: (o.sources as PublisherFieldSources) ?? {},
  };
}

function loadPersisted(
  engagementId: string,
): { form: PublisherIntakeForm; sources: PublisherFieldSources } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(engagementId));
    if (!raw) return null;
    return JSON.parse(raw) as {
      form: PublisherIntakeForm;
      sources: PublisherFieldSources;
    };
  } catch {
    return null;
  }
}

function persistState(
  engagementId: string,
  form: PublisherIntakeForm,
  sources: PublisherFieldSources,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    storageKey(engagementId),
    JSON.stringify({ form, sources }),
  );
}

const SOURCE_LABELS: Record<PublisherFieldSource, string> = {
  engagement: "Engagement",
  site: "Site",
  briefing: "Briefing",
  model: "Model",
  demo: "Demo",
  manual: "Manual",
};

export function PublisherIntakeWorkbench({
  engagement,
  snapshotId,
  onNavigate,
  packageRecord,
  onPersistPackage,
}: {
  engagement: EngagementDetail;
  snapshotId: string | null;
  onNavigate?: (tab: TabId) => void;
  packageRecord?: EngagementPackageRecord | null;
  onPersistPackage?: (patch: {
    formSnapshot: PackageFormSnapshot;
    selection?: PackageSelection;
  }) => Promise<void>;
}) {
  const briefingQuery = useGetEngagementBriefing(engagement.id, {
    query: {
      enabled: !!engagement.id,
      queryKey: getGetEngagementBriefingQueryKey(engagement.id),
    },
  });

  const draft = useMemo(
    () =>
      buildPublisherIntakeDraft(
        engagement,
        briefingQuery.data ?? null,
      ),
    [engagement, briefingQuery.data],
  );

  const [form, setForm] = useState<PublisherIntakeForm>(() => draft.form);
  const [sources, setSources] = useState<PublisherFieldSources>(() => draft.sources);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const persisted =
      loadPersistedFromPackage(packageRecord?.formSnapshot) ??
      (packageRecord ? null : loadPersisted(engagement.id));
    const fresh = buildPublisherIntakeDraft(
      engagement,
      briefingQuery.data ?? null,
    );
    if (persisted) {
      const merged = mergePublisherIntakeDraft(
        persisted.form,
        persisted.sources,
        fresh,
      );
      setForm(merged.form);
      setSources(merged.sources);
    } else {
      setForm(fresh.form);
      setSources(fresh.sources);
    }
    setHydrated(true);
  }, [engagement, briefingQuery.data, engagement.id, packageRecord?.id, packageRecord?.formSnapshot]);

  useEffect(() => {
    if (!hydrated) return;
    if (onPersistPackage && packageRecord) {
      const timer = window.setTimeout(() => {
        void onPersistPackage({
          formSnapshot: {
            ...(packageRecord.formSnapshot ?? {}),
            publisherIntake: { form, sources },
          },
        });
      }, 600);
      return () => window.clearTimeout(timer);
    }
    persistState(engagement.id, form, sources);
    return undefined;
  }, [
    engagement.id,
    form,
    sources,
    hydrated,
    onPersistPackage,
    packageRecord,
  ]);

  const setScalar = useCallback(
    (key: PublisherIntakeFieldKey, value: string) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setSources((prev) => ({ ...prev, [key]: "manual" }));
    },
    [],
  );

  const toggleMulti = useCallback(
    (key: "porchTypes" | "foundations" | "architecturalStyles" | "planFeatures" | "garageTypes", item: string) => {
      setForm((prev) => {
        const list = prev[key];
        const next = list.includes(item)
          ? list.filter((x) => x !== item)
          : [...list, item];
        return { ...prev, [key]: next };
      });
      setSources((prev) => ({ ...prev, [key]: "manual" }));
    },
    [],
  );

  const updateRoom = useCallback(
    (roomId: string, field: keyof PublisherIntakeRoomRow, value: string) => {
      setForm((prev) => ({
        ...prev,
        rooms: prev.rooms.map((r) =>
          r.id === roomId ? { ...r, [field]: value } : r,
        ),
      }));
      setSources((prev) => ({ ...prev, rooms: "manual" }));
    },
    [],
  );

  const updateProductPrice = useCallback((product: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      planProductsPricing: { ...prev.planProductsPricing, [product]: value },
    }));
    setSources((prev) => ({ ...prev, planProductsPricing: "manual" }));
  }, []);

  const refreshAutoFill = useCallback(() => {
    const next = mergePublisherIntakeDraft(form, sources, draft);
    setForm(next.form);
    setSources(next.sources);
  }, [draft, form, sources]);

  const autoCount = countAutoFilledFields(sources);
  const { filled, total } = countRequiredPublisherFields(form);
  const completionPct = Math.round((filled / total) * 100);

  return (
    <div
      className="cockpit-tab cockpit-publish-tab publisher-intake-tab"
      data-testid="publish-prep-tab"
      data-engagement-id={engagement.id}
    >
      <TabHeader
        overline="Publish"
        title="Publisher intake"
        subtitle="Assemble your deliverable package — intake sheet, renderings, videos, and plans — then export for the publisher."
        testId="publish-prep-tab-header"
      />

      <PublisherDeliverablePackage
        engagementId={engagement.id}
        snapshotId={snapshotId}
        engagementName={engagement.name}
        form={form}
        completionPct={completionPct}
        autoFilledCount={autoCount}
        onNavigate={onNavigate}
        packageSelection={packageRecord?.selection ?? null}
        onSelectionPersist={
          onPersistPackage && packageRecord
            ? (selection) =>
                onPersistPackage({
                  formSnapshot: {
                    ...(packageRecord.formSnapshot ?? {}),
                    publisherIntake: { form, sources },
                  },
                  selection: {
                    includeIntake: selection.includeIntake,
                    renderIds: selection.renderIds,
                    videoIds: selection.videoIds,
                    sheetIds: selection.sheetIds,
                  },
                })
            : undefined
        }
      />

      <div className="publisher-intake-toolbar sc-card">
        <div>
          <div className="publisher-intake-toolbar-kicker">EXHIBIT C FORM</div>
          <p className="publisher-intake-toolbar-sub sc-meta">
            Edit auto-filled fields below. Manual changes are kept when you refresh.
          </p>
        </div>
        <div className="publisher-intake-toolbar-actions">
          <button
            type="button"
            className="sc-btn-ghost"
            data-testid="publisher-intake-refresh"
            onClick={refreshAutoFill}
          >
            <RefreshCw size={14} /> Refresh auto-fill
          </button>
          <button
            type="button"
            className="sc-btn-ghost"
            data-testid="publisher-intake-export-csv"
            onClick={() => downloadPublisherIntakeCsv(form, engagement.name)}
          >
            <Download size={14} /> Intake CSV only
          </button>
        </div>
      </div>

      <div className="publisher-intake-scroll sc-scroll">
      <form
        className="publisher-intake-form"
        data-testid="publisher-intake-form"
        onSubmit={(e) => e.preventDefault()}
      >
        <IntakeSection
          title="Plan identity"
          hint="Designer and plan identifiers"
        >
          <FieldGrid>
            <TextField
              label="Designer Name"
              value={form.designerName}
              source={sources.designerName}
              onChange={(v) => setScalar("designerName", v)}
            />
            <TextField
              label="Designer Plan Number"
              value={form.designerPlanNumber}
              source={sources.designerPlanNumber}
              onChange={(v) => setScalar("designerPlanNumber", v)}
            />
            <TextField
              label="Designer Plan Name"
              value={form.designerPlanName}
              source={sources.designerPlanName}
              onChange={(v) => setScalar("designerPlanName", v)}
            />
            <TextField
              label="Date"
              value={form.formDate}
              source={sources.formDate}
              onChange={(v) => setScalar("formDate", v)}
            />
            <TextField
              label="ABHP Number"
              value={form.abhpNumber}
              source={sources.abhpNumber}
              onChange={(v) => setScalar("abhpNumber", v)}
              placeholder="Publisher-assigned"
            />
          </FieldGrid>
        </IntakeSection>

        <IntakeSection title="Plan classification" hint="Type, size, garage">
          <FieldGrid>
            <SelectField
              label="Plan Type"
              value={form.planType}
              source={sources.planType}
              options={PUBLISHER_PLAN_TYPES.map((p) => ({
                value: p.id,
                label: p.label,
              }))}
              onChange={(v) => setScalar("planType", v)}
            />
            <SelectField
              label="Number of Stories"
              value={form.numberOfStories}
              source={sources.numberOfStories}
              options={PUBLISHER_STORY_OPTIONS.map((p) => ({
                value: p.id,
                label: p.label,
              }))}
              onChange={(v) => setScalar("numberOfStories", v)}
            />
            <TextField
              label="Number of Bedrooms"
              value={form.numberOfBedrooms}
              source={sources.numberOfBedrooms}
              onChange={(v) => setScalar("numberOfBedrooms", v)}
            />
            <TextField
              label="Number of Full Baths"
              value={form.numberOfFullBaths}
              source={sources.numberOfFullBaths}
              onChange={(v) => setScalar("numberOfFullBaths", v)}
            />
            <TextField
              label="Number of Half Baths"
              value={form.numberOfHalfBaths}
              source={sources.numberOfHalfBaths}
              onChange={(v) => setScalar("numberOfHalfBaths", v)}
            />
            <TextField
              label="Garage Stalls"
              value={form.garageStalls}
              source={sources.garageStalls}
              onChange={(v) => setScalar("garageStalls", v)}
            />
            <TextField
              label="Main Roof Pitch"
              value={form.mainRoofPitch}
              source={sources.mainRoofPitch}
              onChange={(v) => setScalar("mainRoofPitch", v)}
              placeholder="e.g. 8"
              suffix="/ 12"
            />
          </FieldGrid>
          <CheckboxGroup
            label="Type of Garage"
            items={[...PUBLISHER_GARAGE_TYPES]}
            selected={form.garageTypes}
            source={sources.garageTypes}
            onToggle={(item) => toggleMulti("garageTypes", item)}
          />
        </IntakeSection>

        <IntakeSection title="Square footage" hint="Heated and unheated areas">
          <FieldGrid columns={3}>
            <TextField label="First Floor" value={form.sqftFirstFloor} source={sources.sqftFirstFloor} onChange={(v) => setScalar("sqftFirstFloor", v)} />
            <TextField label="Second Floor" value={form.sqftSecondFloor} source={sources.sqftSecondFloor} onChange={(v) => setScalar("sqftSecondFloor", v)} />
            <TextField label="Third Floor" value={form.sqftThirdFloor} source={sources.sqftThirdFloor} onChange={(v) => setScalar("sqftThirdFloor", v)} />
            <TextField label="Basement" value={form.sqftBasement} source={sources.sqftBasement} onChange={(v) => setScalar("sqftBasement", v)} />
            <TextField label="Garage" value={form.sqftGarage} source={sources.sqftGarage} onChange={(v) => setScalar("sqftGarage", v)} />
            <TextField label="Bonus Room" value={form.sqftBonusRoom} source={sources.sqftBonusRoom} onChange={(v) => setScalar("sqftBonusRoom", v)} />
            <TextField label="Total Heated" value={form.sqftTotalHeated} source={sources.sqftTotalHeated} onChange={(v) => setScalar("sqftTotalHeated", v)} />
          </FieldGrid>
        </IntakeSection>

        <IntakeSection title="Measurements" hint="Feet and inches">
          <FieldGrid columns={3}>
            <TextField label="Width of House" value={form.widthFeetInches} source={sources.widthFeetInches} onChange={(v) => setScalar("widthFeetInches", v)} placeholder={`62'-0"`} />
            <TextField label="Depth of House" value={form.depthFeetInches} source={sources.depthFeetInches} onChange={(v) => setScalar("depthFeetInches", v)} />
            <TextField label="Height of House" value={form.heightFeetInches} source={sources.heightFeetInches} onChange={(v) => setScalar("heightFeetInches", v)} />
          </FieldGrid>
        </IntakeSection>

        <IntakeSection title="Style & foundation">
          <CheckboxGroup
            label="Porch Type"
            items={[...PUBLISHER_PORCH_TYPES]}
            selected={form.porchTypes}
            source={sources.porchTypes}
            onToggle={(item) => toggleMulti("porchTypes", item)}
          />
          <CheckboxGroup
            label="Foundations"
            items={[...PUBLISHER_FOUNDATIONS]}
            selected={form.foundations}
            source={sources.foundations}
            onToggle={(item) => toggleMulti("foundations", item)}
          />
          <CheckboxGroup
            label="Architectural Styles"
            items={[...PUBLISHER_ARCHITECTURAL_STYLES]}
            selected={form.architecturalStyles}
            source={sources.architecturalStyles}
            onToggle={(item) => toggleMulti("architecturalStyles", item)}
            columns={4}
          />
          <TextField
            label="Other Suggested Styles"
            value={form.otherSuggestedStyles}
            source={sources.otherSuggestedStyles}
            onChange={(v) => setScalar("otherSuggestedStyles", v)}
            fullWidth
          />
        </IntakeSection>

        <IntakeSection title="Plan products & pricing" hint="Enter price next to each product">
          <div className="publisher-intake-pricing-grid">
            {PUBLISHER_PLAN_PRODUCTS.map((product) => (
              <label key={product} className="publisher-intake-pricing-row">
                <span className="publisher-intake-pricing-label">{product}</span>
                <input
                  type="text"
                  className="publisher-intake-input"
                  value={form.planProductsPricing[product] ?? ""}
                  onChange={(e) => updateProductPrice(product, e.target.value)}
                  placeholder="$"
                />
              </label>
            ))}
          </div>
          <TextField
            label="CAD File Formats Available"
            value={form.cadFileFormats}
            source={sources.cadFileFormats}
            onChange={(v) => setScalar("cadFileFormats", v)}
            fullWidth
            placeholder="DWG, RVT, PDF…"
          />
        </IntakeSection>

        <IntakeSection title="Plan features">
          <CheckboxGroup
            label="Features (circle all that apply)"
            items={[...PUBLISHER_PLAN_FEATURES]}
            selected={form.planFeatures}
            source={sources.planFeatures}
            onToggle={(item) => toggleMulti("planFeatures", item)}
            columns={3}
          />
        </IntakeSection>

        <IntakeSection title="Description of house">
          <label className="publisher-intake-field publisher-intake-field--full">
            <span className="publisher-intake-field-label">
              Description
              {sources.houseDescription && (
                <SourceBadge source={sources.houseDescription} />
              )}
            </span>
            <textarea
              className="publisher-intake-textarea"
              rows={5}
              value={form.houseDescription}
              onChange={(e) => setScalar("houseDescription", e.target.value)}
              data-testid="publisher-intake-description"
            />
          </label>
          {onNavigate && (
            <div className="publisher-intake-links">
              <button type="button" className="sc-btn-ghost sc-btn-sm" onClick={() => onNavigate("site")}>
                Enrich from Site
              </button>
              <button type="button" className="sc-btn-ghost sc-btn-sm" onClick={() => onNavigate("property-intel")}>
                Property Intel
              </button>
              <button type="button" className="sc-btn-ghost sc-btn-sm" onClick={() => onNavigate("renders")}>
                Rendering assets
              </button>
            </div>
          )}
        </IntakeSection>

        <IntakeSection
          title="Room schedule"
          hint="Width, depth, ceiling height, ceiling type"
        >
          <div className="publisher-intake-room-table-wrap">
            <table className="publisher-intake-room-table" data-testid="publisher-intake-room-table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Width</th>
                  <th>Depth</th>
                  <th>Ceiling Height</th>
                  <th>Ceiling Type</th>
                </tr>
              </thead>
              <tbody>
                {form.rooms.map((room) => (
                  <tr key={room.id}>
                    <td>{room.name}</td>
                    {(["width", "depth", "ceilingHeight", "ceilingType"] as const).map(
                      (field) => (
                        <td key={field}>
                          <input
                            type="text"
                            className="publisher-intake-input publisher-intake-input--cell"
                            value={room[field]}
                            onChange={(e) =>
                              updateRoom(room.id, field, e.target.value)
                            }
                          />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </IntakeSection>
      </form>
      </div>
    </div>
  );
}


function IntakeSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sc-card publisher-intake-section">
      <header className="publisher-intake-section-head">
        <h3 className="publisher-intake-section-title">{title}</h3>
        {hint ? <p className="publisher-intake-section-hint sc-meta">{hint}</p> : null}
      </header>
      <div className="publisher-intake-section-body">{children}</div>
    </section>
  );
}

function FieldGrid({
  children,
  columns = 2,
}: {
  children: React.ReactNode;
  columns?: 2 | 3;
}) {
  return (
    <div
      className="publisher-intake-field-grid"
      data-columns={String(columns)}
    >
      {children}
    </div>
  );
}

function SourceBadge({ source }: { source: PublisherFieldSource }) {
  if (source === "manual") return null;
  return (
    <span className="publisher-intake-source-badge" title={`Auto-filled from ${SOURCE_LABELS[source]}`}>
      <Sparkles size={10} aria-hidden />
      {SOURCE_LABELS[source]}
    </span>
  );
}

function TextField({
  label,
  value,
  source,
  onChange,
  placeholder,
  suffix,
  fullWidth,
}: {
  label: string;
  value: string;
  source?: PublisherFieldSource;
  onChange: (value: string) => void;
  placeholder?: string;
  suffix?: string;
  fullWidth?: boolean;
}) {
  return (
    <label
      className={`publisher-intake-field${fullWidth ? " publisher-intake-field--full" : ""}`}
    >
      <span className="publisher-intake-field-label">
        {label}
        {source && <SourceBadge source={source} />}
      </span>
      <div className="publisher-intake-input-wrap">
        <input
          type="text"
          className="publisher-intake-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
        />
        {suffix ? <span className="publisher-intake-input-suffix">{suffix}</span> : null}
      </div>
    </label>
  );
}

function SelectField({
  label,
  value,
  source,
  options,
  onChange,
}: {
  label: string;
  value: string;
  source?: PublisherFieldSource;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="publisher-intake-field">
      <span className="publisher-intake-field-label">
        {label}
        {source && <SourceBadge source={source} />}
      </span>
      <select
        className="publisher-intake-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        <option value="">Select…</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxGroup({
  label,
  items,
  selected,
  source,
  onToggle,
  columns = 2,
}: {
  label: string;
  items: string[];
  selected: string[];
  source?: PublisherFieldSource;
  onToggle: (item: string) => void;
  columns?: 2 | 3 | 4;
}) {
  return (
    <fieldset className="publisher-intake-checkbox-group">
      <legend className="publisher-intake-field-label">
        {label}
        {source && source !== "manual" && <SourceBadge source={source} />}
      </legend>
      <div
        className="publisher-intake-checkbox-grid"
        data-columns={String(columns)}
      >
        {items.map((item) => {
          const checked = selected.includes(item);
          return (
            <label key={item} className="publisher-intake-checkbox">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(item)}
              />
              <span>{item}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
