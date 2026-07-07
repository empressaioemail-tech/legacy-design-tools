import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, act } from '@testing-library/react'
import { EngagementProvider, useEngagement, type ActiveParcel } from './EngagementProvider'

describe('EngagementProvider 0.2.0 features', () => {
  describe('initialParcel seeding', () => {
    it('seeds initial state with partial parcel', () => {
      const initialParcel: Partial<ActiveParcel> = {
        engagementId: 'eng-123',
        apn: '123-456-789',
        projectDid: 'proj-abc',
        label: 'Test Project',
      }

      const { result } = renderHook(() => useEngagement(), {
        wrapper: ({ children }) => (
          <EngagementProvider initialParcel={initialParcel}>
            {children}
          </EngagementProvider>
        ),
      })

      expect(result.current.engagementId).toBe('eng-123')
      expect(result.current.activeParcel.apn).toBe('123-456-789')
      expect(result.current.activeParcel.projectDid).toBe('proj-abc')
      expect(result.current.activeParcel.label).toBe('Test Project')
    })

    it('merges initialParcel over null defaults', () => {
      const { result } = renderHook(() => useEngagement(), {
        wrapper: ({ children }) => (
          <EngagementProvider initialParcel={{ apn: '111' }}>
            {children}
          </EngagementProvider>
        ),
      })

      expect(result.current.activeParcel.apn).toBe('111')
      expect(result.current.activeParcel.lat).toBeNull()
      expect(result.current.activeParcel.lng).toBeNull()
      expect(result.current.activeParcel.address).toBeNull()
    })
  })

  describe('onActiveParcelChange callback', () => {
    it('fires after setEngagement with committed value', () => {
      const onChange = vi.fn()
      const { result } = renderHook(() => useEngagement(), {
        wrapper: ({ children }) => (
          <EngagementProvider onActiveParcelChange={onChange}>
            {children}
          </EngagementProvider>
        ),
      })

      const initialCallCount = onChange.mock.calls.length

      act(() => {
        result.current.setEngagement('eng-456', {
          id: 'eng-456',
          apn: '999',
          address: '123 Main St',
          jurisdiction: 'Austin',
          latitude: 30.27,
          longitude: -97.74,
        } as any)
      })

      expect(onChange).toHaveBeenCalled()
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
      expect(lastCall[0].engagementId).toBe('eng-456')
      expect(lastCall[0].apn).toBe('999')
      expect(lastCall[0].address).toBe('123 Main St')
    })

    it('fires after setActiveParcel with committed value', () => {
      const onChange = vi.fn()
      const { result } = renderHook(() => useEngagement(), {
        wrapper: ({ children }) => (
          <EngagementProvider onActiveParcelChange={onChange}>
            {children}
          </EngagementProvider>
        ),
      })

      const initialCallCount = onChange.mock.calls.length

      act(() => {
        result.current.setActiveParcel({
          apn: '777',
          lat: 40.0,
          lng: -100.0,
          projectDid: 'proj-xyz',
        })
      })

      expect(onChange).toHaveBeenCalled()
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
      expect(lastCall[0].apn).toBe('777')
      expect(lastCall[0].lat).toBe(40.0)
      expect(lastCall[0].lng).toBe(-100.0)
      expect(lastCall[0].projectDid).toBe('proj-xyz')
    })
  })

  describe('context adoption', () => {
    it('nested provider renders children against parent state', () => {
      const parentOnChange = vi.fn()
      const childOnChange = vi.fn()

      function ProbeChild() {
        const { activeParcel, setActiveParcel } = useEngagement()
        return (
          <button
            onClick={() =>
              setActiveParcel({ apn: 'child-update', lat: 1.0, lng: 2.0 })
            }
          >
            {activeParcel.apn ?? 'none'}
          </button>
        )
      }

      const { getByRole } = render(
        <EngagementProvider
          initialParcel={{ apn: 'parent-initial' }}
          onActiveParcelChange={parentOnChange}
        >
          <EngagementProvider
            initialParcel={{ apn: 'child-initial' }}
            onActiveParcelChange={childOnChange}
          >
            <ProbeChild />
          </EngagementProvider>
        </EngagementProvider>
      )

      const button = getByRole('button')
      expect(button.textContent).toBe('parent-initial')

      act(() => {
        button.click()
      })

      expect(button.textContent).toBe('child-update')
      expect(parentOnChange).toHaveBeenCalled()
      expect(childOnChange).not.toHaveBeenCalled()
    })
  })

  describe('contextEpoch', () => {
    it('starts at 0 and increments on setEngagement', () => {
      const { result } = renderHook(() => useEngagement(), {
        wrapper: ({ children }) => (
          <EngagementProvider>{children}</EngagementProvider>
        ),
      })

      expect(result.current.contextEpoch).toBe(0)

      act(() => {
        result.current.setEngagement('eng-1')
      })

      expect(result.current.contextEpoch).toBe(1)

      act(() => {
        result.current.setEngagement('eng-2')
      })

      expect(result.current.contextEpoch).toBe(2)
    })

    it('increments on setActiveParcel', () => {
      const { result } = renderHook(() => useEngagement(), {
        wrapper: ({ children }) => (
          <EngagementProvider>{children}</EngagementProvider>
        ),
      })

      expect(result.current.contextEpoch).toBe(0)

      act(() => {
        result.current.setActiveParcel({ apn: 'test-1', lat: 1.0, lng: 2.0 })
      })

      expect(result.current.contextEpoch).toBe(1)

      act(() => {
        result.current.setActiveParcel({ apn: 'test-2', lat: 3.0, lng: 4.0 })
      })

      expect(result.current.contextEpoch).toBe(2)
    })
  })

  describe('SpaceSnapshot context field', () => {
    it('round-trips context when provided', () => {
      const snapshot = {
        tileIds: ['tile-1'],
        layoutId: '1x1',
        colFr: [1],
        rowFr: [1],
        context: {
          engagementId: 'eng-999',
          apn: '555',
          address: '789 Oak St',
          jurisdiction: 'Dallas',
          lat: 32.78,
          lng: -96.8,
          projectDid: 'proj-test',
          label: 'Oak Street Project',
        },
      }

      expect(snapshot.context?.projectDid).toBe('proj-test')
      expect(snapshot.context?.label).toBe('Oak Street Project')
    })

    it('omits context when not provided', () => {
      const snapshot = {
        tileIds: ['tile-1'],
        layoutId: '1x1',
        colFr: [1],
        rowFr: [1],
      }

      expect(snapshot.context).toBeUndefined()
    })
  })
})
