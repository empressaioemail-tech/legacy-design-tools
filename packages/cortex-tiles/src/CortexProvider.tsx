import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { CortexClient } from '@empressaio/cortex-client'

const CortexContext = createContext<CortexClient | null>(null)

export function CortexProvider({ client, children }: { client: CortexClient; children: ReactNode }) {
  return <CortexContext.Provider value={client}>{children}</CortexContext.Provider>
}

export function useCortexClient(): CortexClient {
  const client = useContext(CortexContext)
  if (!client) throw new Error('useCortexClient must be used inside CortexProvider')
  return client
}
