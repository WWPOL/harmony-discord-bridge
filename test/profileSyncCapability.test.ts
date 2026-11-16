import { describe, expect, it } from 'vitest'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { CAPABILITY } from '../src/HarmonyClient.js'
import { buildCommands } from '../src/runtime/commands.js'

const featuresFor = (capabilities: string[]) => {
  const fake = {
    mode: 'v2',
    hooks: {},
    harmony: { hasCapability: (name: string) => capabilities.includes(name) },
  }
  return BridgeRuntime.prototype.commandFeatures.call(fake)
}
const subcommands = (capabilities: string[]) =>
  (buildCommands('v2', featuresFor(capabilities)).find(c => c.name === 'bridge')!.options ?? []).map(o => o.name)

describe('/bridge sync-profile registration', () => {
  it('names the capability the Harmony gateway sends', () => {
    expect(CAPABILITY.profileSync).toBe('bridge_profile_sync')
  })

  it('is registered when the gateway lists bridge_profile_sync', () => {
    expect(subcommands(['bridge_profile_sync'])).toContain('sync-profile')
  })

  it('is not registered when the gateway lacks it', () => {
    expect(subcommands(['bridge_sound_sync'])).not.toContain('sync-profile')
    expect(subcommands([])).not.toContain('sync-profile')
  })
})
