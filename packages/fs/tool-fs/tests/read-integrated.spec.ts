/**
 * The `imageReadMode: integrated` routing over the REAL local filesystem and
 * attachment store: `read` alone serves text windows and image files, no
 * `read_image` registers, pagination arguments never reach an image read, and
 * the text contract stays byte-identical to `separate` mode.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

const testToolSignal = new AbortController().signal

/** Exact-route fake adapter; `stream` is unreachable in these tests. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: LlmModelInfo[]) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const resolved = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: resolved?.name ?? model,
      ...resolved?.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] },
    })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('integrated read tests never stream')
  }
}

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-read-integrated-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-read-integrated-home-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

interface SetupOptions {
  attachments?: boolean
  imageReadMode?: ToolFs.Config['imageReadMode']
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  if (options.attachments !== false) {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  }
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new CatalogAdapter([
    { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
  ]))
  await ctx.plugin(ToolFs, { imageReadMode: options.imageReadMode ?? 'integrated' })
  return ctx
}

/** A fake calling agent pinned to one routed provider/model. */
function agentOn(model: string | undefined, provider = 'visual', messages: readonly Message[] = []): object {
  return {
    options: {},
    session: {
      header: { cwd: dir },
      requestHeader: () => (model === undefined ? undefined : { config: { provider, model } }),
      deriveMessages: () => [...messages],
      append: () => undefined,
    },
  }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`integrated-call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent: agent as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('integrated mode registration', () => {
  it('registers no read_image while read stays registered', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('read')?.name).toBe('read')
    expect(ctx.tools.get('read_image')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps read_image in separate mode', async () => {
    const ctx = await setup({ imageReadMode: 'separate' })
    expect(ctx.tools.get('read_image')?.name).toBe('read_image')
    await ctx.fiber.dispose()
  })

  it('fails loud at load when no attachment service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    await expect(ctx.plugin(ToolFs, { imageReadMode: 'integrated' })).rejects.toThrow(
      'tool-fs: imageReadMode "integrated" requires the attachment service',
    )
    await ctx.fiber.dispose()
  })
})

describe('integrated read routing', () => {
  it('returns the image envelope beside an image block for a declared image path', async () => {
    await writeFile(join(dir, 'dot.png'), PNG_1X1)
    const ctx = await setup()
    const result = await call(ctx, 'read', { file_path: 'dot.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(2)
    const [envelope, image] = result.content
    if (envelope?.type !== 'text' || image?.type !== 'image') throw new Error('expected envelope plus image block')
    expect(envelope.text).toContain('<type>image</type>')
    expect(envelope.text).toContain('image/png image, 1x1 px')
    expect(image.attachment.mediaType).toBe('image/png')
    expect(result.meta).toEqual({ path: join(dir, 'dot.png') })
    // The image record carries no line window, so presentation declines to the
    // generic card instead of the read card.
    expect(ctx.tools.get('read')?.presentResult?.({ file_path: 'dot.png' }, result)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('refuses pagination arguments on an image read before any I/O', async () => {
    await writeFile(join(dir, 'dot.png'), PNG_1X1)
    const ctx = await setup()
    const result = await call(ctx, 'read', { file_path: 'dot.png', offset: 1 }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('offset and limit are text-read arguments; image reads do not accept them')
    await ctx.fiber.dispose()
  })

  it('keeps the text window byte-identical for non-image paths', async () => {
    await writeFile(join(dir, 'a.ts'), 'const x = 1\nconst y = 2')
    const ctx = await setup()
    const result = await call(ctx, 'read', { file_path: 'a.ts' }, agentOn('text-model'))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`<path>${join(dir, 'a.ts')}</path>
<type>file</type>
<content>
1: const x = 1
2: const y = 2

(End of file - total 2 lines)
</content>`)
    expect(result.meta).toEqual({
      path: join(dir, 'a.ts'),
      offset: 1,
      lines: [{ number: 1, text: 'const x = 1' }, { number: 2, text: 'const y = 2' }],
      totalLines: 2,
      lang: 'ts',
    })
    await ctx.fiber.dispose()
  })

  it('routes an extension-less image through the text path, where the provider refuses binary', async () => {
    await writeFile(join(dir, 'logo'), PNG_1X1)
    const ctx = await setup()
    const result = await call(ctx, 'read', { file_path: 'logo' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('binary file')
    await ctx.fiber.dispose()
  })

  it('keeps the strict image-capability gate from the image path', async () => {
    await writeFile(join(dir, 'dot.png'), PNG_1X1)
    const ctx = await setup()
    const result = await call(ctx, 'read', { file_path: 'dot.png' }, agentOn('text-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('model "text-model" does not declare image input')
    await ctx.fiber.dispose()
  })
})
