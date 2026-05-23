import { useMemo, useState } from "react";
import {
  MNML_COMMON_PARAMS,
  MNML_EXPERT_PARAMS,
  type MnmlExpertName,
  type MnmlParamDef,
  mnmlExpertParamCount,
  validateMnmlParamValue,
} from "../schemas/mnml-experts";

export interface MnmlExpertParamGridProps {
  expert: MnmlExpertName;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
  testId?: string;
}

function defaultFor(def: MnmlParamDef): string {
  if (def.type === "enum" && def.default != null) return String(def.default);
  if (def.type === "number" && def.default != null) return String(def.default);
  return "";
}

function ParamControl({
  def,
  value,
  disabled,
  onChange,
}: {
  def: MnmlParamDef;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const id = `mnml-param-${def.name}`;
  if (def.type === "enum") {
    return (
      <select
        id={id}
        className="sc-ui"
        disabled={disabled}
        value={value || defaultFor(def)}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`mnml-param-${def.name}`}
        style={{
          background: "var(--bg-input)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          padding: "4px 8px",
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        {def.allowedValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === "number") {
    const n = value === "" ? defaultFor(def) : value;
    if (def.range && def.uiHint === "slider") {
      return (
        <input
          id={id}
          type="range"
          disabled={disabled}
          min={def.range.min}
          max={def.range.max}
          step={def.range.step ?? 1}
          value={n}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`mnml-param-${def.name}`}
          style={{ width: "100%" }}
        />
      );
    }
    return (
      <input
        id={id}
        type="number"
        disabled={disabled}
        min={def.range?.min}
        max={def.range?.max}
        step={def.range?.step ?? 1}
        value={n}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`mnml-param-${def.name}`}
        className="sc-ui"
        style={{
          background: "var(--bg-input)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          padding: "4px 8px",
          borderRadius: 4,
          fontSize: 12,
          width: "100%",
        }}
      />
    );
  }
  return null;
}

/**
 * doc 40e B.1 — schema-driven per-expert parameter grid for kickoff.
 */
export function MnmlExpertParamGrid({
  expert,
  values,
  onChange,
  disabled,
  testId = "mnml-expert-param-grid",
}: MnmlExpertParamGridProps) {
  const [openCommon, setOpenCommon] = useState(true);
  const [openExpert, setOpenExpert] = useState(true);

  const expertParams = MNML_EXPERT_PARAMS[expert];
  const total = mnmlExpertParamCount(expert);

  const setParam = (name: string, v: string) => {
    onChange({ ...values, [name]: v });
  };

  const validationErrors = useMemo(() => {
    const defs = [...MNML_COMMON_PARAMS, ...expertParams].filter(
      (d) => d.type !== "file",
    );
    const errs: string[] = [];
    for (const def of defs) {
      const raw = values[def.name] ?? defaultFor(def);
      if (raw === "" && !def.required) continue;
      const r = validateMnmlParamValue(def, raw);
      if (!r.ok) errs.push(r.reason);
    }
    return errs;
  }, [expertParams, values]);

  const renderSection = (
    title: string,
    defs: readonly MnmlParamDef[],
    open: boolean,
    setOpen: (v: boolean) => void,
    sectionId: string,
  ) => (
    <section data-testid={`${testId}-${sectionId}`}>
      <button
        type="button"
        className="sc-btn-ghost"
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          textAlign: "left",
          fontWeight: 600,
          fontSize: 12,
          marginBottom: open ? 8 : 0,
        }}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(120px, 1fr) minmax(140px, 2fr)",
            gap: "8px 12px",
            alignItems: "center",
          }}
        >
          {defs
            .filter((d) => d.type !== "file")
            .map((def) => (
              <div key={def.name} style={{ display: "contents" }}>
                <label htmlFor={`mnml-param-${def.name}`} className="sc-meta">
                  {def.name.replace(/_/g, " ")}
                </label>
                <ParamControl
                  def={def}
                  value={values[def.name] ?? ""}
                  disabled={disabled}
                  onChange={(v) => setParam(def.name, v)}
                />
              </div>
            ))}
        </div>
      )}
    </section>
  );

  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="sc-meta" style={{ opacity: 0.8 }}>
        Advanced mnml parameters ({total} fields)
      </div>
      {renderSection("Common", MNML_COMMON_PARAMS, openCommon, setOpenCommon, "common")}
      {renderSection(
        `Expert · ${expert}`,
        expertParams,
        openExpert,
        setOpenExpert,
        "expert",
      )}
      {validationErrors.length > 0 && (
        <div role="alert" className="sc-meta" style={{ color: "#ef4444" }} data-testid={`${testId}-errors`}>
          {validationErrors[0]}
        </div>
      )}
    </div>
  );
}
