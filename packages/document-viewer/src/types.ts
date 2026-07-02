export type AnnotationKind = 'finding' | 'redline' | 'shape' | 'text' | 'stamp' | 'dimension'

export type Annotation = {
  id: string
  engagementId: string
  author: 'ai' | string
  kind: AnnotationKind
  findingId?: string
  confidence?: { value: number; kind: 'calibrated' | 'asserted' | 'deterministic' }
  createdAt: string
  location2d?: {
    submissionId: string
    page: number
    bbox: [number, number, number, number]
    label: string
  }
  location3d?: {
    globalId: string
    elementId: string
    face?: number
    label: string
  }
}
