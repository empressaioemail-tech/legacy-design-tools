import type { ReactElement } from 'react'

export type TileStatus = 'live' | 'degraded' | 'partial' | 'planned'
export type TileCategory = 'Compliance' | 'Site Analysis' | 'Property Intel' | 'Design Accelerator' | 'Deliverable' | 'Market'

export type TileDef = {
  id: string
  label: string
  category: TileCategory
  status: TileStatus
  degradedReason?: string
  /**
   * Which shell provider backs this tile. App-supplied registry field.
   */
  engine?: 'engagement' | 'spatial' | 'code'
  requires?: {
    engagementId?: boolean
    apn?: boolean
    jurisdiction?: boolean
    uploadedDocuments?: boolean
    completedFindings?: boolean
  }
  produces?: {
    spatialOverlays?: boolean
    findings?: boolean
    annotations?: boolean
    letter?: boolean
  }
  modes?: Array<'full' | 'card' | 'inline' | 'raw'>
  minWidth?: number
  /** Minimum grid column share the tile prefers (0..1). App-supplied. */
  minColShare?: number
  mcpTools?: string[]
  el: () => ReactElement
}

export type WorkspaceComposition = {
  engagementId?: string
  tiles: string[]
  layoutId: string
  why: string
}

export type LayoutSpec = {
  id: string
  template: string
}

export type PresetSpace = {
  id: string
  label: string
  tiles: string[]
  layoutId: string
}

export type OverlaySpec = {
  id: string
  kind: string
  label: string
  geojson?: {
    type: string
    features: unknown[]
  }
  opacity?: number
}

export type EngagementReportResult = {
  // Superset of the plan-review report statuses. Matches @hauska/cortex-client
  // ReportStatus so a client-fetched Engagement assigns cleanly into the shell.
  status: 'running' | 'not-run' | 'error' | 'ok' | 'degraded' | 'unavailable'
  result?: unknown
  error?: string
  degradedReason?: string
  generationId?: string
}

export type EngagementDetail = {
  id: string
  name: string
  jurisdiction: string | null
  address: string | null
  apn: string | null
  applicantName: string | null
  latitude?: number | null
  longitude?: number | null
  reportResults: Record<string, EngagementReportResult>
}

export type PrecedenceResultWire = {
  topic: string
  ruleApplied: string
  governingAtomId: string
  comparedAtomIds: string[]
}
