/** The pi bundle must carry one parseable preset layer whose operation space is exactly four tools. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface Entry {
  id?: string
  name?: string
  disabled?: unknown
  config?: Record<string, unknown>
}

interface Patch {
  id?: string
  insert?: Entry[]
}

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  private?: boolean
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

function piPresetPlugins(): Entry[] {
  const parsed = yaml.load(
    readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  )
  const patches = parsed as Patch[]
  const row = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'preset-pi')
  const config = row?.config as { plugins?: Entry[] } | undefined
  return config?.plugins ?? []
}

describe('pi bundle declaration', () => {
  it('declares a public parseable layer with its composition dependencies', () => {
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./pi.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-agent-preset': 'workspace:*',
      '@deepseek-ai/dsh-agent-tool-presentation': 'workspace:*',
      '@deepseek-ai/dsh-tool-bash': 'workspace:*',
      '@deepseek-ai/dsh-tool-fs': 'workspace:*',
      '@deepseek-ai/dsh-tool-pwsh': 'workspace:*',
    })
  })

  it('mounts exactly one of the two platform shells, foreground-only', () => {
    const plugins = piPresetPlugins()
    const bash = plugins.find(entry => entry.id === 'tool-bash')
    const pwsh = plugins.find(entry => entry.id === 'tool-pwsh')
    expect(bash).toMatchObject({
      name: '@deepseek-ai/dsh-tool-bash',
      config: { enableRunInBackground: false, promoteOnTimeout: false },
    })
    expect(pwsh).toMatchObject({
      name: '@deepseek-ai/dsh-tool-pwsh',
      config: { enableRunInBackground: false, promoteOnTimeout: false },
    })
    // Both platform rows stay declared with `disabled: !!js` expressions; the
    // loader evaluates exactly one off per platform.
    expect(bash?.disabled).toBeDefined()
    expect(pwsh?.disabled).toBeDefined()
  })

  it('routes image reads through read itself', () => {
    expect(piPresetPlugins().find(entry => entry.id === 'tool-fs')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-fs',
      config: { imageReadMode: 'integrated' },
    })
  })

  it('selects native tool calling explicitly', () => {
    expect(piPresetPlugins().find(entry => entry.id === 'tool-presentation')).toMatchObject({
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'native' },
    })
  })

  it('keeps repository instructions and compaction, and no other model-facing tool rows', () => {
    const plugins = piPresetPlugins()
    expect(plugins.find(entry => entry.id === 'agent-instructions')).toMatchObject({
      name: '@deepseek-ai/dsh-agent-instructions',
    })
    const compaction = plugins.find(entry => entry.id === 'compaction')
    expect(compaction).toMatchObject({ name: 'cordis:group' })
    // A cordis:group row carries its children as its `config` list.
    const compactionChildren = (compaction?.config ?? []) as Entry[]
    expect(compactionChildren.map(entry => entry.id)).toEqual(['compaction-basic', 'command-compact', 'tool-result-pruner'])

    // The model's operation space: read/write/edit (tool-fs) plus one shell.
    // Every other tool the shipped presets expose stays unmounted.
    const mounted = plugins.map(entry => entry.id)
    for (const absent of [
      'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill',
      'command-goal', 'tool-goal', 'tool-ask-user', 'tool-todo', 'tool-web',
      'tool-subagent-control', 'tool-subagent', 'tool-workflow', 'plan-mode', 'present',
      'tool-plugin-manager',
    ]) {
      expect(mounted).not.toContain(absent)
    }
  })
})
