import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { CortexApiError } from '@empressaio/cortex-client'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

type SetbackDistrict = {
  district_name?: string | null
  front_ft?: number | null
  rear_ft?: number | null
  side_ft?: number | null
  side_corner_ft?: number | null
  max_height_ft?: number | null
  max_lot_coverage_pct?: number | null
  max_impervious_pct?: number | null
  citation_url?: string | null
}

type LocalSetbackTable = {
  jurisdictionKey?: string
  jurisdictionDisplayName?: string
  note?: string | null
  districts?: SetbackDistrict[]
}

const mutedText: CSSProperties = {
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-muted)',
}

function num(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—'
}

function LocalSetbacksTileInner() {
  const client = useCortexClient()
  const { activeParcel } = useEngagement()
  const jurisdiction = activeParcel.jurisdiction
  const [table, setTable] = useState<LocalSetbackTable | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    setTable(null)
    setError(null)
    setNotFound(false)
    if (!jurisdiction) return
    setLoading(true)
    client
      .fetch<LocalSetbackTable>(
        '/local/setbacks/' + encodeURIComponent(jurisdiction),
      )
      .then((res) => {
        if (!cancelled) setTable(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof CortexApiError && err.status === 404) {
          setNotFound(true)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load setbacks')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jurisdiction, client])

  const districts = Array.isArray(table?.districts) ? table.districts : []

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
      <TileStatusBanner status="live" label="Local Setbacks" />

      {!jurisdiction ? (
        <span style={mutedText}>
          Search an address or select an engagement to load setbacks.
        </span>
      ) : loading ? (
        <span style={mutedText}>Loading…</span>
      ) : notFound ? (
        <span style={mutedText}>
          No codified setback table for this jurisdiction ({jurisdiction}).
        </span>
      ) : error ? (
        <div role="alert" style={{ ...mutedText, color: 'var(--h-error)' }}>
          {error}
        </div>
      ) : table ? (
        <>
          <div
            style={{
              fontWeight: 700,
              fontSize: 'var(--h-text-sm)',
              color: 'var(--h-text-primary)',
            }}
          >
            {table.jurisdictionDisplayName ?? jurisdiction}
          </div>
          {table.note ? (
            <div style={{ ...mutedText, lineHeight: 1.4 }}>{table.note}</div>
          ) : null}

          {districts.length === 0 ? (
            <span style={mutedText}>No districts in this table.</span>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  fontSize: 'var(--h-text-sm)',
                }}
              >
                <thead>
                  <tr>
                    {[
                      'District',
                      'Front',
                      'Rear',
                      'Side',
                      'Corner',
                      'Height',
                      'Coverage %',
                      'Impervious %',
                      '',
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left',
                          padding: '4px 8px',
                          borderBottom: '1px solid var(--h-border-subtle)',
                          color: 'var(--h-text-muted)',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {districts.map((d, i) => (
                    <tr key={d.district_name ?? i}>
                      <td style={cellStyle}>{d.district_name ?? '—'}</td>
                      <td style={cellStyle}>{num(d.front_ft)}</td>
                      <td style={cellStyle}>{num(d.rear_ft)}</td>
                      <td style={cellStyle}>{num(d.side_ft)}</td>
                      <td style={cellStyle}>{num(d.side_corner_ft)}</td>
                      <td style={cellStyle}>{num(d.max_height_ft)}</td>
                      <td style={cellStyle}>{num(d.max_lot_coverage_pct)}</td>
                      <td style={cellStyle}>{num(d.max_impervious_pct)}</td>
                      <td style={cellStyle}>
                        {d.citation_url ? (
                          <a
                            href={d.citation_url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--h-accent)' }}
                          >
                            cite
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {districts.some((d) => d.citation_url) ? (
            <div style={{ ...mutedText, fontSize: 11 }}>
              Source: codified zoning ordinance (per-district citation links above).
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

const cellStyle: CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid var(--h-border-subtle)',
  color: 'var(--h-text-primary)',
  whiteSpace: 'nowrap',
}

export function LocalSetbacksTile() {
  return (
    <TileErrorBoundary label="Local Setbacks">
      <LocalSetbacksTileInner />
    </TileErrorBoundary>
  )
}
