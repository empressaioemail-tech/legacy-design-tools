// Jurisdiction resolution helpers — pure functions.

export type JurisdictionSummary = {
  key: string
  displayName: string
  atomCount: number
}

export type EngagementSummary = {
  jurisdiction: string | null
}

export type EngagementSubmissionSummary = {
  jurisdiction: string | null
}

function cleanLabel(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function normalizeJurisdiction(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export interface JurisdictionContext {
  engagementLabel: string | null
  submissionLabel: string | null
  snapshotDiverged: boolean
}

export function resolveJurisdictionContext(
  engagement: Pick<EngagementSummary, 'jurisdiction'> | null,
  submission: Pick<EngagementSubmissionSummary, 'jurisdiction'> | null,
): JurisdictionContext {
  const engagementLabel = cleanLabel(engagement?.jurisdiction)
  const submissionLabel = cleanLabel(submission?.jurisdiction)
  const snapshotDiverged =
    engagementLabel !== null &&
    submissionLabel !== null &&
    normalizeJurisdiction(engagementLabel) !== normalizeJurisdiction(submissionLabel)
  return { engagementLabel, submissionLabel, snapshotDiverged }
}

export function matchJurisdiction(
  label: string | null,
  jurisdictions: ReadonlyArray<JurisdictionSummary>,
): JurisdictionSummary | null {
  const clean = cleanLabel(label)
  if (clean === null) return null
  const norm = normalizeJurisdiction(clean)
  if (norm === '') return null
  return (
    jurisdictions.find((j) => normalizeJurisdiction(j.key) === norm || normalizeJurisdiction(j.displayName) === norm) ??
    null
  )
}

export function describeCorpus(jurisdiction: JurisdictionSummary): string {
  const noun = jurisdiction.atomCount === 1 ? 'atom' : 'atoms'
  return `${jurisdiction.atomCount.toLocaleString()} indexed code ${noun}`
}
