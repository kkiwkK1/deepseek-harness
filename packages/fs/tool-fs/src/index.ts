/**
 * Model-facing read, read_image, write, and edit tools over `ctx.fs`. This package owns schemas, validation,
 * read windows, formatting, and observation events, never a concrete provider. An optional
 * event policy supplies mutation guards; without one the tools use unconditional provider calls.
 * The `imageReadMode` config picks between the dedicated `read_image` tool (`separate`, the
 * default) and routing image files through `read` itself (`integrated`).
 * @module @deepseek-ai/dsh-tool-fs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
  /**
   * Image-read routing. `separate` (default) keeps `read` text-only and
   * registers `read_image` beside it while `attachments` is mounted;
   * `integrated` routes image files through `read` and registers no
   * `read_image`, and requires the attachment service at load.
   */
  imageReadMode?: 'separate' | 'integrated'
}

export const Config: z<Config> = z.object({
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
  imageReadMode: z.union(['separate', 'integrated']).default('separate'),
})

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/**
 * Register the `read`/`write`/`edit` filesystem tool suite. Image reads stay
 * on the dedicated `read_image` tool in `separate` mode (registered only while
 * `attachments` is mounted); in `integrated` mode `read` handles images itself
 * and no `read_image` registers.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as Required<Config>
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  if (resolved.imageReadMode === 'integrated' && ctx.get('attachments') === undefined) {
    throw new Error('tool-fs: imageReadMode "integrated" requires the attachment service: image reads commit their bytes durably before returning')
  }
  applyReadTool(ctx, {
    limit: resolved.readLimit,
    maxLineLength: resolved.readMaxLineLength,
    maxBytes: resolved.readMaxBytes,
    streamMinSize: resolved.readStreamMinSize,
    images: resolved.imageReadMode,
  })
  // read_image is composition-conditional: without a mounted attachment store
  // the deployment cannot durably commit image bytes, so the tool never
  // registers; the execute body keeps a defensive re-check for direct callers.
  if (resolved.imageReadMode === 'separate') {
    ctx.inject(['attachments'], (imageCtx) => {
      applyReadImageTool(imageCtx)
    })
  }
  // One escalation API shared by both mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off whether
  // the mounted ctx.fs confines (ctx.fs.sandboxMode).
  const sandbox = new FsSandboxController(ctx)
  applyWriteTool(ctx, sandbox)
  applyEditTool(ctx, sandbox)
}
