import type { ReactElement } from 'react'

export type TileStatus = 'live' | 'degraded' | 'partial' | 'planned'
export type TileCategory = 'Compliance' | 'Site Analysis' | 'Property Intel' | 'Design Accelerator' | 'Deliverable' | 'Market'

export type TileDef = {
  id: string
  label: string
  category: TileCategory
  status: TileStatus
  degradedReason?: string
  requires: {
    engagementId?: boolean
    apn?: boolean
    jurisdiction?: boolean
    uploadedDocuments?: boolean
    completedFindings?: boolean
  }
  produces: {
    spatialOverlays?: boolean
    findings?: boolean
    annotations?: boolean
    letter?: boolean
  }
  modes: Array<'full' | 'card' | 'inline' | 'raw'>
  minWidth?: number
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
