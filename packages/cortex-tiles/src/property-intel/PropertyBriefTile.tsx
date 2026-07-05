import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement } from '@empressaio/tile-shell'
import type { CortexClient } from '@empressaio/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import { TileStatusBanner } from '@empressaio/tile-shell'

type BriefNarrative = {
  sectionA?: string | null
  sectionB?: string | null
  sectionC?: string | null
  sectionD?: string | null
  sectionE?: string | null
  sectionF?: string | null
  sectionG?: string | null
  generatedAt?: string | null
  generationId?: string | null
}

type BriefSource = {
  layerKind?: string
  provider?: string | null
  snapshotDate?: string | null
  sourceKind?: string | null
  payload?: unknown
}

type BriefResult = {
  sources?: BriefSource[]
  narrative?: BriefNarrative
  coverage?: { covered?: boolean; note?: string | null } | null
  degraded?: boolean
  note?: string | null
}

const SECTION_LABELS: Array<[keyof BriefNarrative, string]> = [
  ['sectionA', 'Site context'],
  ['sectionB', 'Parcel'],
  ['sectionC', 'Zoning & code'],
  ['sectionD', 'Hazard'],
  ['sectionE', 'Market'],
  ['sectionF', 'Utilities & access'],
  ['sectionG', 'Summary'],
]

async function pollReport(
  client: CortexClient,
  engagementId: string,
  type: string,
  attempts = 12,
): Promise<{ status: string; result?: unknown; error?: string; degradedReason?: string }> {
  for (let i = 0; i < attempts; i++) {
    const report = await client.getReport(engagementId, type)
    if (report.status !== 'running') return report
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { status: 'running' }
}

export type PropertyBriefMode = 'full' | 'card' | 'inline' | 'raw'

function PropertyBriefTileInner({
  mode = 'full',
  children,
}: {
  mode?: PropertyBriefMode
  children?: (data: BriefResult | null) => React.ReactNode
}) {
  const client = useCortexClient()
  const { engagementId, activeParcel } = useEngagement()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [result, setResult] = useState<BriefResult | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  // Load an already-generated brief for the active engagement when the tile
  // mounts / the parcel changes, so a selected engagement's brief renders
  // without requiring a manual Run.
  useEffect(() => {
    let cancelled = false
    if (!engagementId) {
      setResult(null)
      return
    }
    client
      .getReport<BriefResult>(engagementId, 'property-brief')
      .then((r) => {
        if (cancelled) return
        if (r.status === 'ok' && r.result) setResult(r.result)
      })
      .catch(() => {
        /* silent — Run surfaces errors */
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await client.runReport(engagementId, 'property-brief')
      const report = await pollReport(client, engagementId, 'property-brief')
      // The engine is moving to a graceful 200-with-fallback rather than a 500;
      // render whatever comes back. A degraded / coverage-noted result is still
      // a result — show it with the coverage note, do not treat it as an error.
      if (report.status === 'error') {
        // Even on error the engine may return a partial result body.
        if (report.result) {
          setResult(report.result as BriefResult)
          setNote(report.error ?? 'Brief returned a degraded result.')
        } else {
          setError(report.error ?? 'Property brief generation failed')
        }
        return
      }
      if (report.status === 'running') {
        setNote('Brief still generating — try again shortly.')
        return
      }
      if (report.status === 'not-run') {
        setError('No briefing sources yet — ensure the parcel is geocoded.')
        return
      }
      const body = (report.result ?? null) as BriefResult | null
      setResult(body)
      const cov = body?.coverage
      if (report.status === 'degraded' || body?.degraded) {
        setNote(body?.note ?? report.degradedReason ?? 'Degraded coverage for this parcel.')
      } else if (cov && cov.covered === false) {
        setNote(cov.note ?? 'Outside primary coverage — result may be web-scraped and unverified.')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Property brief run failed')
    } finally {
      setBusy(false)
    }
  }

  // raw mode: headless escape hatch — the tile owns data + state, consumer renders.
  if (mode === 'raw') {
    return <>{children ? children(result) : null}</>
  }

  const addressLine =
    activeParcel.address ||
    (activeParcel.apn ? `APN ${activeParcel.apn}` : null) ||
    (activeParcel.lat != null && activeParcel.lng != null
      ? `${activeParcel.lat.toFixed(4)}, ${activeParcel.lng.toFixed(4)}`
      : null)

  // ── card / inline compact mode (used by the map-click property summary) ──
  if (mode === 'card' || mode === 'inline') {
    const summary =
      result?.narrative?.sectionG ||
      result?.narrative?.sectionA ||
      null
    return (
      <div
        style={{
          padding: 'var(--h-space-sm)',
          fontSize: 'var(--h-text-sm)',
          color: 'var(--h-text-primary)',
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Property Brief</div>
        {addressLine ? (
          <div style={{ color: 'var(--h-text-muted)', marginBottom: 6 }}>
            {addressLine}
          </div>
        ) : null}
        {!engagementId ? (
          <div style={{ color: 'var(--h-text-muted)' }}>
            Select an engagement to run the full brief for this parcel.
          </div>
        ) : summary ? (
          <div style={{ marginBottom: 6, lineHeight: 1.4 }}>
            {truncate(summary, 220)}
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRun()}
            style={runButtonStyle(busy)}
          >
            {busy ? 'Running…' : 'Run brief'}
          </button>
        )}
        {note ? (
          <div style={{ color: 'var(--h-warning)', marginTop: 4, fontSize: 11 }}>
            {note}
          </div>
        ) : null}
      </div>
    )
  }

  // ── full mode ──
  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--h-space-sm)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Property Brief" />

      {/* Address / parcel input driven by the shared active-parcel context —
          answers "how do I put in an address" (the top-bar search sets it; the
          tile shows what's active and lets you run). */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--h-text-muted)',
          border: '1px solid var(--h-border-subtle)',
          borderRadius: 'var(--h-radius-sm)',
          padding: '6px 8px',
        }}
      >
        <span style={{ fontWeight: 600 }}>Active parcel: </span>
        {addressLine ? (
          <span style={{ color: 'var(--h-text-primary)' }}>{addressLine}</span>
        ) : (
          <span>
            none — search an address in the top bar or select an engagement.
          </span>
        )}
      </div>

      {!engagementId ? (
        <p style={mutedP}>
          Select a case (or search an address that resolves to an engagement) to
          run the full brief.
        </p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleRun()}
          style={runButtonStyle(busy)}
        >
          {busy ? 'Running…' : 'Run property brief'}
        </button>
      )}

      {note ? (
        <div role="status" style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-warning)' }}>
          {note}
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}>
          {error}
        </div>
      ) : null}

      {result ? (
        <>
          {SECTION_LABELS.map(([key, label]) => {
            const body = result.narrative?.[key]
            if (typeof body !== 'string' || !body.trim()) return null
            return (
              <section key={key}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--h-text-muted)',
                    marginBottom: 2,
                  }}
                >
                  {label}
                </div>
                <div style={{ fontSize: 'var(--h-text-sm)', lineHeight: 1.45 }}>
                  {body}
                </div>
              </section>
            )
          })}

          {result.sources && result.sources.length > 0 ? (
            <section>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: 'var(--h-text-muted)',
                  marginBottom: 4,
                }}
              >
                Sources &amp; provenance
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11 }}>
                {result.sources.map((s, i) => (
                  <li key={i} style={{ color: 'var(--h-text-muted)' }}>
                    {s.layerKind ?? 'layer'}
                    {s.provider ? ` · ${s.provider}` : ''}
                    {s.snapshotDate ? ` · ${s.snapshotDate.slice(0, 10)}` : ''}
                    {s.sourceKind ? ` · ${s.sourceKind}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            style={rawToggleStyle}
          >
            {showRaw ? 'Hide raw' : 'View raw'}
          </button>
          {showRaw ? (
            <pre style={rawPre}>{JSON.stringify(result, null, 2)}</pre>
          ) : null}
        </>
      ) : engagementId && !busy && !error ? (
        <p style={mutedP}>
          Run the property brief to fetch site context, parcel layers, hazard,
          and narrative sections.
        </p>
      ) : null}
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const mutedP: CSSProperties = {
  margin: 0,
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-muted)',
}

function runButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: 'var(--h-space-sm) 14px',
    borderRadius: 'var(--h-radius-sm)',
    border: 'none',
    background: 'var(--h-accent)',
    color: '#fff',
    fontSize: 'var(--h-text-sm)',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    alignSelf: 'flex-start',
  }
}

const rawToggleStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '2px 8px',
  borderRadius: 'var(--h-radius-sm)',
  border: '1px solid var(--h-border-subtle)',
  background: 'transparent',
  color: 'var(--h-text-muted)',
  fontSize: 11,
  cursor: 'pointer',
}

const rawPre: CSSProperties = {
  margin: 0,
  padding: 'var(--h-space-sm)',
  background: 'var(--h-surface-2)',
  borderRadius: 'var(--h-radius-md)',
  overflow: 'auto',
  maxHeight: 240,
  fontSize: 11,
}

export function PropertyBriefTile({
  mode = 'full',
  children,
}: {
  mode?: PropertyBriefMode
  children?: (data: BriefResult | null) => React.ReactNode
} = {}) {
  return (
    <TileErrorBoundary label="Property Brief">
      <PropertyBriefTileInner mode={mode} children={children} />
    </TileErrorBoundary>
  )
}
