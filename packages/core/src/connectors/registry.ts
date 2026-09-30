import { createGoogleConnectorManifest } from './google/manifest.js'
import type { ConnectorManifest } from './types.js'

/**
 * The production registry. Only real connectors live here; a synthetic manifest
 * stays in its fixture and is registered by tests (AGENTS.md).
 */
const builtinConnectors: ConnectorManifest[] = [createGoogleConnectorManifest()]

export interface ConnectorRegistry {
  list: () => ConnectorManifest[]
  get: (id: string) => ConnectorManifest | null
  register: (manifest: ConnectorManifest) => void
}

export function createConnectorRegistry(manifests: ConnectorManifest[] = []): ConnectorRegistry {
  const byId = new Map<string, ConnectorManifest>()
  const register = (manifest: ConnectorManifest): void => {
    if (byId.has(manifest.id)) throw new Error(`Connector already registered: ${manifest.id}`)
    byId.set(manifest.id, manifest)
  }
  for (const manifest of manifests) register(manifest)

  return {
    list: () => [...byId.values()],
    get: id => byId.get(id) ?? null,
    register,
  }
}

let defaultRegistry: ConnectorRegistry | null = null

/** Process-wide registry of the connectors this build ships. */
export function getConnectorRegistry(): ConnectorRegistry {
  defaultRegistry ??= createConnectorRegistry(builtinConnectors)
  return defaultRegistry
}

export function listConnectorManifests(): ConnectorManifest[] {
  return getConnectorRegistry().list()
}

export function getConnectorManifest(id: string): ConnectorManifest | null {
  return getConnectorRegistry().get(id)
}
