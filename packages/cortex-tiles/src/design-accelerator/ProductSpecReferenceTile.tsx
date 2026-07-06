import { useEffect, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

const mutedText: CSSProperties = {
  fontSize: 'var(--h-text-sm)',
  color: 'var(--h-text-muted)',
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function readStr(x: Record<string, unknown>, key: string): string | null {
  const v = x[key]
  return typeof v === 'string' && v.trim() ? v : null
}

type SpecView = {
  key: string
  productName: string
  productManufacturer: string | null
  esrNumber: string | null
  status: string | null
  iccEsUrl: string | null
  lastVerifiedAt: string | null
}

function toSpecView(x: unknown, index: number): SpecView {
  if (!isRecord(x)) {
    return {
      key: String(index),
      productName: `Reference ${index + 1}`,
      productManufacturer: null,
      esrNumber: null,
      status: null,
      iccEsUrl: null,
      lastVerifiedAt: null,
    }
  }
  const key =
    readStr(x, 'id') ?? readStr(x, 'entityId') ?? readStr(x, 'esrNumber') ?? String(index)
  return {
    key,
    productName: readStr(x, 'productName') ?? `Reference ${index + 1}`,
    productManufacturer: readStr(x, 'productManufacturer'),
    esrNumber: readStr(x, 'esrNumber'),
    status: readStr(x, 'status'),
    iccEsUrl: readStr(x, 'iccEsUrl'),
    lastVerifiedAt: readStr(x, 'lastVerifiedAt'),
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

function statusTone(status: string | null): string {
  if (!status) return 'var(--h-text-muted)'
  const s = status.toLowerCase()
  if (s.includes('active') || s.includes('valid')) return 'var(--h-success)'
  if (s.includes('expire') || s.includes('revok')) return 'var(--h-error)'
  if (s.includes('pending') || s.includes('review')) return 'var(--h-warning)'
  return 'var(--h-text-muted)'
}

function SpecCard({ view }: { view: SpecView }) {
  const verified = formatDate(view.lastVerifiedAt)
  return (
    <li
      style={{
        border: '1px solid var(--h-border-subtle)',
        borderRadius: 'var(--h-radius-sm)',
        padding: '8px 10px',
        background: 'var(--h-surface-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-primary)',
          }}
        >
          {view.productName}
        </span>
        {view.status ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: statusTone(view.status),
              border: `1px solid ${statusTone(view.status)}`,
              borderRadius: 'var(--h-radius-sm)',
              padding: '1px 6px',
            }}
          >
            {view.status}
          </span>
        ) : null}
      </div>

      {view.productManufacturer ? (
        <div style={mutedText}>{view.productManufacturer}</div>
      ) : null}

      {view.esrNumber ? (
        <div style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-text-primary)' }}>
          ESR:{' '}
          {view.iccEsUrl ? (
            <a
              href={view.iccEsUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--h-accent)' }}
            >
              {view.esrNumber}
            </a>
          ) : (
            view.esrNumber
          )}
        </div>
      ) : null}

      {verified ? (
        <div style={{ ...mutedText, fontSize: 11 }}>Last verified {verified}</div>
      ) : null}
    </li>
  )
}

function ProductSpecReferenceTileInner() {
  const client = useCortexClient()
  const { engagementId } = useEngagement()
  const [refs, setRefs] = useState<unknown[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRefs([])
    setError(null)
    if (!engagementId) return
    setLoading(true)
    client
      .fetch<{ productSpecReferences: unknown[] }>(
        '/engagements/' + engagementId + '/product-spec-references',
      )
      .then((res) => {
        if (!cancelled)
          setRefs(Array.isArray(res?.productSpecReferences) ? res.productSpecReferences : [])
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load references')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [engagementId, client])

  return (
    <div
      style={{
        padding: 'var(--h-space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <TileStatusBanner status="live" label="Product Spec Reference" />

      {!engagementId ? (
        <span style={mutedText}>Select a case to view product-spec references.</span>
      ) : loading ? (
        <span style={mutedText}>Loading…</span>
      ) : error ? (
        <div role="alert" style={{ ...mutedText, color: 'var(--h-error)' }}>
          {error}
        </div>
      ) : refs.length === 0 ? (
        <span style={mutedText}>No product-spec references for this engagement.</span>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--h-space-xs)',
          }}
        >
          {refs.map((r, i) => {
            const view = toSpecView(r, i)
            return <SpecCard key={view.key} view={view} />
          })}
        </ul>
      )}
    </div>
  )
}

export function ProductSpecReferenceTile() {
  return (
    <TileErrorBoundary label="Product Spec Reference">
      <ProductSpecReferenceTileInner />
    </TileErrorBoundary>
  )
}
