import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'
import {
  fetchHazardProfile,
  ReportHttpError,
  type HazardData,
  type HazardLayer,
} from '../site-analysis/siteReports'

type HazardResult = HazardData

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/**
 * Pull a human flood-zone label out of a hazard layer payload. FEMA flood
 * layers carry a zone code (e.g. "X", "AE") under one of a few field names
 * depending on the adapter; read defensively.
 */
function floodZoneFrom(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const candidates = [
    payload.floodZone,
    payload.zone,
    payload.fldZone,
    payload.FLD_ZONE,
    isRecord(payload.flood) ? payload.flood.zone : undefined,
  ]
  for (const c of candidates) {
    const s = readStr(c)
    if (s) return s
  }
  return null
}

/** A confidence object {value,kind} if the payload carries one (atom contract). */
function confidenceFrom(payload: unknown): { value?: number; kind?: string } | null {
  if (!isRecord(payload)) return null
  const c = payload.confidence
  if (isRecord(c) && (typeof c.value === 'number' || typeof c.kind === 'string')) {
    return { value: c.value as number | undefined, kind: c.kind as string | undefined }
  }
  return null
}

const CONF_COLOR: Record<string, string> = {
  calibrated: 'var(--h-confidence-calibrated)',
  asserted: 'var(--h-confidence-asserted)',
  deterministic: 'var(--h-confidence-deterministic)',
}

function HazardProfileTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HazardResult | null>(null)
  const [quotaBanner, setQuotaBanner] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  // Render an already-loaded hazard profile when the engagement changes.
  useEffect(() => {
    let cancelled = false
    if (!engagementId) {
      setResult(null)
      return
    }
    client
      .getReport<HazardResult>(engagementId, 'hazard')
      .then((r) => {
        if (cancelled) return
        if (r.status === 'ok' && r.result) setResult(r.result)
      })
      .catch(() => {
        /* Run surfaces errors */
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  async function handleRun() {
    if (!engagementId) return
    setBusy(true)
    setError(null)
    setQuotaBanner(null)
    try {
      // Single source of truth: the pure fetchHazardProfile function.
      const state = await fetchHazardProfile(
        client.config.baseUrl,
        { engagementId },
        undefined,
        { getToken: client.config.getToken },
      )
      if (state.status === 'error') {
        setError(state.message)
        return
      }
      if (state.status === 'not-run' || state.status === 'unavailable') {
        setError('No hazard layers returned — check geocode and retry.')
        return
      }
      if (state.status === 'degraded' && state.result?.quotaExhausted) {
        setQuotaBanner('Hazard data quota exhausted — demo keys expire ~2026-07-06.')
      }
      setResult(state.result ?? null)
    } catch (err: unknown) {
      // ReportHttpError carries the upstream status so a 429 maps to the
      // honest quota banner instead of a bare error.
      const status = err instanceof ReportHttpError ? err.status : null
      const msg = err instanceof Error ? err.message : 'Hazard run failed'
      if (status === 429 || msg.includes('429') || msg.includes('quota')) {
        setQuotaBanner('Hazard data quota exhausted — demo keys expire ~2026-07-06.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const layers = result?.layers ?? []
  const floodLayer = layers.find((l) => floodZoneFrom(l.payload) != null)
  const floodZone = floodLayer ? floodZoneFrom(floodLayer.payload) : null

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
      <TileStatusBanner status="live" label="Hazard Profile" />

      {!engagementId ? (
        <p style={mutedP}>Select a case first.</p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleRun()}
          style={runButtonStyle(busy)}
        >
          {busy ? 'Running…' : 'Run hazard profile'}
        </button>
      )}

      {quotaBanner ? (
        <div role="status" style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-warning)' }}>
          {quotaBanner}
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}>
          {error}
        </div>
      ) : null}

      {floodZone ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '8px 10px',
            background: 'var(--h-surface-2)',
            borderRadius: 'var(--h-radius-md)',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--h-text-muted)' }}>FEMA flood zone</span>
          <span style={{ fontSize: 18, fontWeight: 700 }}>{floodZone}</span>
        </div>
      ) : null}

      {layers.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {layers.map((layer, i) => {
            const conf = confidenceFrom(layer.payload)
            return (
              <div
                key={i}
                style={{
                  border: '1px solid var(--h-border-subtle)',
                  borderRadius: 'var(--h-radius-sm)',
                  padding: '6px 8px',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 'var(--h-text-sm)' }}>
                  {layer.layerKind ?? 'hazard layer'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--h-text-muted)', marginTop: 2 }}>
                  {layer.provider ? `${layer.provider}` : 'provider n/a'}
                  {layer.snapshotDate ? ` · as of ${layer.snapshotDate.slice(0, 10)}` : ''}
                  {layer.sourceKind ? ` · ${layer.sourceKind}` : ''}
                </div>
                {conf ? (
                  <div style={{ fontSize: 11, marginTop: 2 }}>
                    <span
                      style={{
                        color:
                          (conf.kind && CONF_COLOR[conf.kind]) ||
                          'var(--h-text-muted)',
                        fontWeight: 600,
                      }}
                    >
                      {conf.value != null ? conf.value.toFixed(2) : '—'}{' '}
                      {conf.kind ?? ''}
                    </span>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : engagementId && !busy && !error ? (
        <p style={mutedP}>
          Run hazard profile for FEMA flood zone and Cotality peril layers.
        </p>
      ) : null}

      {result ? (
        <>
          <button type="button" onClick={() => setShowRaw((v) => !v)} style={rawToggleStyle}>
            {showRaw ? 'Hide raw' : 'View raw'}
          </button>
          {showRaw ? <pre style={rawPre}>{JSON.stringify(result, null, 2)}</pre> : null}
        </>
      ) : null}
    </div>
  )
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

export function HazardProfileTile() {
  return (
    <TileErrorBoundary label="Hazard Profile">
      <HazardProfileTileInner />
    </TileErrorBoundary>
  )
}
