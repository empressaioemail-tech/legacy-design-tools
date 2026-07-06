// Finding presentation helpers — pure label maps + formatters.

export type FindingSeverity = 'blocker' | 'concern' | 'advisory'
export type FindingCategory =
  | 'setback'
  | 'height'
  | 'coverage'
  | 'egress'
  | 'use'
  | 'overlay-conflict'
  | 'divergence-related'
  | 'other'
export type FindingStatus = 'ai-produced' | 'accepted' | 'rejected' | 'overridden' | 'promoted-to-architect'

export type FindingCitation = {
  kind: 'code-section' | 'briefing-source'
  atomId?: string
  label?: string
}

export type FindingActor = {
  displayName: string
  email: string | null
} | null

export type Finding = {
  id: string
  text: string
  severity: FindingSeverity
  category: FindingCategory
  status: FindingStatus
  citations: FindingCitation[]
  confidence?: number | null
  lowConfidence?: boolean
  aiGeneratedAt: string
  aiGenerated: boolean
  elementRef?: string | null
  reviewerStatusBy: FindingActor
  reviewerStatusChangedAt: string | null
  acceptedBy?: FindingActor
  acceptedAt?: string | null
  reviewerComment?: string | null
  revisionOf?: string | null
  readContract?: {
    axes?: {
      calibratedConfidence?: { estimate?: number | null }
      assertedConfidence?: { estimate?: number | null }
    }
  } | null
}

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  blocker: 'Blocker',
  concern: 'Concern',
  advisory: 'Advisory',
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  concern: 1,
  advisory: 2,
}

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  setback: 'Setback',
  height: 'Height',
  coverage: 'Coverage',
  egress: 'Egress',
  use: 'Use',
  'overlay-conflict': 'Overlay conflict',
  'divergence-related': 'Divergence-related',
  other: 'Other',
}

export const STATUS_LABELS: Record<FindingStatus, string> = {
  'ai-produced': 'AI-produced',
  accepted: 'Accepted',
  rejected: 'Rejected',
  overridden: 'Overridden',
  'promoted-to-architect': 'Promoted to architect',
}

export function formatConfidence(value: unknown): string {
  if (value == null || value === '') return '—'
  const n = Number(value)
  if (!isFinite(n)) return '—'
  return `${Math.round(n * 100)}%`
}

export function resolveFindingConfidence(finding: {
  confidence?: number | null
  readContract?: {
    axes?: {
      calibratedConfidence?: { estimate?: number | null }
      assertedConfidence?: { estimate?: number | null }
    }
  } | null
}): unknown {
  if (finding.confidence != null && isFinite(Number(finding.confidence))) return finding.confidence
  return (
    finding.readContract?.axes?.calibratedConfidence?.estimate ??
    finding.readContract?.axes?.assertedConfidence?.estimate
  )
}

export function citationLabel(citation: FindingCitation): string {
  return citation.kind === 'code-section' ? citation.atomId ?? '' : citation.label ?? ''
}

export function sortFindings(findings: ReadonlyArray<Finding>): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return b.aiGeneratedAt.localeCompare(a.aiGeneratedAt)
  })
}

export const SEVERITY_VALUES: FindingSeverity[] = ['blocker', 'concern', 'advisory']
export const CATEGORY_VALUES: FindingCategory[] = [
  'setback',
  'height',
  'coverage',
  'egress',
  'use',
  'overlay-conflict',
  'divergence-related',
  'other',
]

export interface OverrideDraft {
  text: string
  severity: FindingSeverity
  category: FindingCategory
  reviewerComment: string
}

export function actorLabel(actor: FindingActor): string {
  return actor?.displayName ?? 'a reviewer'
}

export function describeAdjudication(finding: Finding): string | null {
  const when = (value: string | null): string =>
    value ? new Date(value).toLocaleString() : 'an unknown time'
  switch (finding.status) {
    case 'accepted':
      return `Accepted by ${actorLabel(finding.acceptedBy ?? finding.reviewerStatusBy)} · ${when(finding.acceptedAt ?? finding.reviewerStatusChangedAt)}`
    case 'rejected':
      return `Rejected by ${actorLabel(finding.reviewerStatusBy)} · ${when(finding.reviewerStatusChangedAt)}`
    case 'overridden':
      return `Overridden by ${actorLabel(finding.reviewerStatusBy)} · ${when(finding.reviewerStatusChangedAt)}`
    case 'promoted-to-architect':
      return 'Promoted to architect'
    case 'ai-produced':
    default:
      return null
  }
}
