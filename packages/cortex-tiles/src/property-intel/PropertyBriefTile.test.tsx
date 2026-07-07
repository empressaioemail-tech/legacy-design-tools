import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { PropertyBriefTile } from './PropertyBriefTile'
import { EngagementProvider } from '@empressaio/tile-shell'
import { CortexClientProvider } from '../CortexProvider'
import type { CortexClient } from '@empressaio/cortex-client'

describe('PropertyBriefTile epoch guard', () => {
  let mockClient: CortexClient
  let getReportSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getReportSpy = vi.fn()
    mockClient = {
      getReport: getReportSpy,
      runReport: vi.fn(),
    } as unknown as CortexClient
  })

  it('discards stale fetch response after context change', async () => {
    let setEngagement: ((id: string) => void) | null = null
    const briefResult = {
      status: 'ok',
      result: {
        narrative: {
          sectionA: 'Site context for engagement 1',
        },
      },
    }

    getReportSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(briefResult), 100)
        })
    )

    function TestWrapper() {
      const { setEngagement: setEng } = require('@empressaio/tile-shell').useEngagement()
      setEngagement = setEng
      return <PropertyBriefTile mode="full" />
    }

    const { container } = render(
      <CortexClientProvider client={mockClient}>
        <EngagementProvider initialParcel={{ engagementId: 'eng-1' }}>
          <TestWrapper />
        </EngagementProvider>
      </CortexClientProvider>
    )

    expect(getReportSpy).toHaveBeenCalledWith('eng-1', 'property-brief')

    await waitFor(() => expect(getReportSpy).toHaveBeenCalledTimes(1))

    if (setEngagement) {
      setEngagement('eng-2')
    }

    await waitFor(
      () => {
        const text = container.textContent || ''
        expect(text).not.toContain('Site context for engagement 1')
      },
      { timeout: 200 }
    )
  })

  it('applies fresh fetch response when epoch unchanged', async () => {
    const briefResult = {
      status: 'ok',
      result: {
        narrative: {
          sectionG: 'Summary narrative',
        },
      },
    }

    getReportSpy.mockResolvedValue(briefResult)

    const { container } = render(
      <CortexClientProvider client={mockClient}>
        <EngagementProvider initialParcel={{ engagementId: 'eng-stable' }}>
          <PropertyBriefTile mode="full" />
        </EngagementProvider>
      </CortexClientProvider>
    )

    await waitFor(() => {
      const text = container.textContent || ''
      expect(text).toContain('Summary narrative')
    })
  })
})
