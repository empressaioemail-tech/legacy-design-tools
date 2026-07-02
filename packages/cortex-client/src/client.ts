export type CortexClientConfig = {
  baseUrl: string
  getToken: () => string | Promise<string>
}

export type CortexClient = {
  config: CortexClientConfig
  fetch: <T>(path: string, init?: RequestInit) => Promise<T>
}

export function createCortexClient(config: CortexClientConfig): CortexClient {
  return {
    config,
    async fetch<T>(path: string, init?: RequestInit): Promise<T> {
      const token = await config.getToken()
      const res = await fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      })
      if (!res.ok) throw new CortexApiError(res.status, await res.text())
      return res.json() as Promise<T>
    },
  }
}

export class CortexApiError extends Error {
  constructor(public status: number, message: string) {
    super(`CortexAPI ${status}: ${message}`)
  }
}
