import { useRef, useState, type CSSProperties } from 'react'
import { useEngagement, TileStatusBanner } from '@empressaio/tile-shell'
import { useCortexClient } from '../CortexProvider'
import { TileErrorBoundary } from '../TileErrorBoundary'

const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.dwg', '.dxf']

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--h-space-xs)',
}

const inputStyle: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 'var(--h-radius-sm)',
  border: '1px solid var(--h-border-subtle)',
  background: 'var(--h-surface-2)',
  color: 'var(--h-text-primary)',
  fontSize: 13,
}

const labelSpanStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--h-text-muted)',
}

type UploadProgress = {
  name: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
}

function isAcceptedFile(file: File): boolean {
  const lower = file.name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function IntakeTileInner() {
  const client = useCortexClient()
  const { engagementId, engagement, setEngagement, bumpQueueRefresh } =
    useEngagement()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [projectName, setProjectName] = useState('')
  const [address, setAddress] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreateAndUpload() {
    if (!projectName.trim()) {
      setError('Project name is required.')
      return
    }
    if (selectedFiles.length === 0) {
      setError('Select at least one document.')
      return
    }
    setError(null)
    setSubmitting(true)
    setUploadProgress(
      selectedFiles.map((f) => ({ name: f.name, status: 'pending' })),
    )
    try {
      const { engagementId: newId } = await client.createEngagement({
        name: projectName.trim(),
        address: address.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
      })

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i]!
        setUploadProgress((prev) =>
          prev.map((p, idx) => (idx === i ? { ...p, status: 'uploading' } : p)),
        )
        try {
          const { uploadUrl, objectPath } =
            await client.requestDocumentUploadUrl(newId, {
              filename: file.name,
              contentType: file.type || 'application/octet-stream',
            })
          const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
            },
            body: file,
          })
          if (!putRes.ok) {
            throw new Error(`Upload failed (${putRes.status})`)
          }
          await client.completeDocumentUpload(newId, {
            objectPath,
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
          })
          setUploadProgress((prev) =>
            prev.map((p, idx) => (idx === i ? { ...p, status: 'done' } : p)),
          )
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Upload failed'
          setUploadProgress((prev) =>
            prev.map((p, idx) =>
              idx === i ? { ...p, status: 'error', error: msg } : p,
            ),
          )
          throw err
        }
      }

      await client.createSubmission(newId, {
        note: `Intake upload: ${selectedFiles.map((f) => f.name).join(', ')}`,
      })
      const detail = await client.getEngagement(newId)
      setEngagement(newId, detail)
      bumpQueueRefresh()
      setProjectName('')
      setAddress('')
      setJurisdiction('')
      setSelectedFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create and upload failed')
    } finally {
      setSubmitting(false)
    }
  }

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
      <TileStatusBanner status="live" label="Intake & Upload" />
      {engagementId && engagement ? (
        <>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--h-text-sm)',
              color: 'var(--h-text-primary)',
            }}
          >
            Active case: <strong>{engagement.name}</strong>
          </p>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--h-text-sm)',
              color: 'var(--h-text-muted)',
            }}
          >
            Upload more documents below or create a new case.
          </p>
        </>
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--h-text-sm)',
            color: 'var(--h-text-muted)',
          }}
        >
          Create a new plan-review case and upload documents.
        </p>
      )}

      <label style={fieldStyle}>
        <span style={labelSpanStyle}>Project name</span>
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          style={inputStyle}
          data-testid="intake-project-name"
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelSpanStyle}>Address</span>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          style={inputStyle}
          data-testid="intake-address"
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelSpanStyle}>Jurisdiction</span>
        <input
          type="text"
          value={jurisdiction}
          onChange={(e) => setJurisdiction(e.target.value)}
          style={inputStyle}
          data-testid="intake-jurisdiction"
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelSpanStyle}>Documents</span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(',')}
          data-testid="intake-file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []).filter(isAcceptedFile)
            setSelectedFiles(files)
            setUploadProgress([])
          }}
        />
      </label>

      {selectedFiles.length > 0 ? (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            fontSize: 'var(--h-text-sm)',
          }}
        >
          {uploadProgress.length > 0
            ? uploadProgress.map((p) => (
                <li key={p.name} style={{ color: 'var(--h-text-muted)' }}>
                  {p.name}:{' '}
                  {p.status === 'uploading'
                    ? 'Uploading…'
                    : p.status === 'done'
                      ? 'Done'
                      : p.status === 'error'
                        ? `Error — ${p.error}`
                        : 'Pending'}
                </li>
              ))
            : selectedFiles.map((f) => (
                <li key={f.name} style={{ color: 'var(--h-text-muted)' }}>
                  {f.name}
                </li>
              ))}
        </ul>
      ) : null}

      <button
        type="button"
        data-testid="intake-create-upload"
        disabled={submitting}
        onClick={() => void handleCreateAndUpload()}
        style={{
          padding: 'var(--h-space-sm) 14px',
          borderRadius: 'var(--h-radius-sm)',
          border: 'none',
          background: 'var(--h-accent)',
          color: '#fff',
          fontSize: 'var(--h-text-sm)',
          fontWeight: 600,
          cursor: submitting ? 'wait' : 'pointer',
          alignSelf: 'flex-start',
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting ? 'Creating…' : 'Create and upload'}
      </button>

      {error ? (
        <div
          role="alert"
          style={{ fontSize: 'var(--h-text-sm)', color: 'var(--h-error)' }}
        >
          {error}
        </div>
      ) : null}
    </div>
  )
}

export function IntakeTile() {
  return (
    <TileErrorBoundary label="Intake & Upload">
      <IntakeTileInner />
    </TileErrorBoundary>
  )
}
