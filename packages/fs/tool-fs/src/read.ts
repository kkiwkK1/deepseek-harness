/**
 * Model-facing UTF-8 read. It performs one provider stat for type, routing, and observed version,
 * streams large or size-unknown files, renders a bounded window, then emits the observation.
 * With `imageReadMode: integrated` a path whose extension declares a supported image routes to
 * the shared image-read path instead (see `read-image.ts`).
 * @module @deepseek-ai/dsh-tool-fs/src/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta, type FileTextLine } from './read-render.ts'
import { resolveRegularReadTarget } from './read-target.ts'
import { IMAGE_VALUE_SCHEMA, imageMediaTypeForPath, imageReadContent, readImageFile, type ImageReadValue } from './read-image.ts'

/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000

/**
 * Default streaming threshold (the `readStreamMinSize` config): files at or
 * above this size stream; smaller files read whole into memory.
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Resolved read-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize: number
  /**
   * Image routing: `separate` keeps `read` text-only, `integrated` routes a
   * path whose extension declares a supported image to the image-read path
   * (no `read_image` registration).
   */
  images: 'separate' | 'integrated'
}

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
}

/** The `read` wire arguments both modes share. */
export interface ReadArgs {
  file_path: string
  offset?: number
  limit?: number
}

/** The structured text-window half of the `read` outcome. */
export interface TextReadValue {
  /** The backend-resolved path rendered in the envelope's `<path>` element. */
  path: string
  /** The 1-based first line the window requested. */
  offset: number
  /** The returned window's lines, each keeping its file line number. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
}

/** The structured `read` outcome: one text window, or one committed image in integrated mode. */
export type ReadOutcome = TextReadValue | ImageReadValue

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns the validated input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }, maxLimit: number): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit }
}

/** The text-window half of the output schema, shared by both routing modes. */
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    offset: { type: 'integer', required: true },
    lines: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
    },
    totalLines: { type: 'integer', required: true },
  },
} as const

/** The integrated-mode output schema: one text window or one committed image. */
const INTEGRATED_OUTPUT_SCHEMA = {
  oneOf: [
    TEXT_OUTPUT_SCHEMA,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        image: IMAGE_VALUE_SCHEMA,
      },
    },
  ],
} as const

/** Pure Native/model rendering of one text window. */
function renderText(args: ReadArgs, value: TextReadValue, maxLimit: number): ContentBlock[] {
  const input = parseReadArgs(args, maxLimit)
  const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
  const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
  return [{
    type: 'text',
    text: formatReadOutput(value.path, {
      offset: value.offset,
      lines: value.lines,
      totalLines: value.totalLines,
      ...truncatedByBytes ? { truncatedByBytes: true } : {},
    }),
  }]
}

/**
 * Register the `read` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps (plugin config after defaulting).
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  const integrated = caps.images === 'integrated'
  const parameters = {
    file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
    offset: { type: 'number', description: '1-based first line to return. Defaults to 1. Text files only.' },
    limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}. Text files only.` },
  } as const
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : integrated
        ? 'Use the read tool — not shell commands like cat — to inspect text files and images. Use offset and limit to continue reading large text files; image reads return the image itself and accept neither argument.'
        : 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.',
  })

  // One stat: absence observation OR type check + size routing + present version.
  // A concurrent write can only make a later guarded mutation fail stale and require reread.
  const readText = async (exec: ToolExecution, input: ReadInput): Promise<TextReadValue> => {
    const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)

    // Stream when the file is large OR size is unknown, so a size-less backend
    // never buffers an arbitrarily large file.
    const chunks = info.size === undefined || info.size >= caps.streamMinSize
      ? await ctx.fs.streamText(target, exec.signal)
      : [await ctx.fs.readText(target, exec.signal)]
    const window = await buildWindow(
      chunks,
      { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
      target.displayPath,
    )

    // Record the present observation (a no-op when no policy plugin listens). The
    // read already succeeded; an fs/observed listener is contractually a
    // synchronous, side-effect-only recorder.
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return { path: target.displayPath, offset: input.offset, lines: window.lines, totalLines: window.totalLines }
  }

  // Pure display: a generic card titled by the file with the read window appended (`Read
  // foo.txt (5 - 8)`), `read` kind (icon), and a follow-along location whose line is the
  // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
  // the title bare instead of smuggling config into this pure presenter.
  const presentCall = (args: ReadArgs): GenericCallView => {
    const { offset, limit } = args
    const window = limit !== undefined && limit > 0
      ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
      : offset !== undefined ? ` (from line ${offset})` : ''
    return {
      card: 'generic',
      title: `Read ${args.file_path}${window}`,
      kind: 'read',
      locations: [{ path: args.file_path, line: offset ?? 1 }],
    }
  }

  // Result-time display: a `read` card carrying the structured line window a
  // capable UI renders as a line-numbered, syntax-highlighted view. The
  // structured data is narrowed from the persisted `meta` (replay-safe); the
  // envelope-stripped model-facing text rides along as `content` so a UI without
  // the read capability still shows the file text. A malformed or absent meta,
  // or a result whose text is not the read envelope, declines to `undefined`
  // (the generic fallback), never throwing on replay of obsolete logged output.
  const presentResult = (_args: unknown, result: ToolResult): ReadResultView | undefined => {
    if (result.isError) return undefined
    const meta = readMetaFromMeta(result.meta)
    if (meta === undefined) return undefined
    const only = result.content.length === 1 ? result.content[0] : undefined
    const text = only?.type === 'text' ? only.text : undefined
    if (text === undefined) return undefined
    // Group 1 always captures (possibly empty) when the envelope matches.
    const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
    if (body === undefined) return undefined
    return {
      card: 'read',
      path: meta.path,
      offset: meta.offset,
      lines: meta.lines,
      totalLines: meta.totalLines,
      ...meta.lang === undefined ? {} : { lang: meta.lang },
      content: [{ type: 'text', text: body }],
    }
  }

  // Project the structured window into persisted `meta` so a UI's read card
  // survives replay: the raw canonical output object is not on the wire, only
  // the model-facing text, from which the line/lang data cannot be recovered.
  const textReadMeta = (value: TextReadValue) => {
    const lang = langFromPath(value.path)
    return {
      path: value.path,
      offset: value.offset,
      lines: value.lines.map(({ number, text }) => ({ number, text })),
      totalLines: value.totalLines,
      ...lang === undefined ? {} : { lang },
    }
  }

  // The two registrations differ only in the output union and the image routing;
  // defineTool infers the value type from the schema literal, so each mode gets
  // its own call site rather than one branch-selected schema expression.
  if (!integrated) {
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'Read a UTF-8 text file and return line-numbered content.',
      parameters,
      output: {
        schema: TEXT_OUTPUT_SCHEMA,
        render: (args, value) => renderText(args, value, caps.limit),
        presentationMeta: (_args, value) => textReadMeta(value),
      },
      // Observation races fail closed because guarded mutations re-check the version in-lock.
      isConcurrencySafe: () => true,
      async execute(args: ReadArgs, exec) {
        return readText(exec, parseReadArgs(args, caps.limit))
      },
      presentCall,
      presentResult,
    }))
    return
  }
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content, or read a PNG/JPEG/WebP/GIF file and return the image itself. '
      + 'Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image. '
      + 'offset and limit apply to text files only.',
    parameters,
    output: {
      schema: INTEGRATED_OUTPUT_SCHEMA,
      render: (args, value: ReadOutcome) => 'image' in value ? imageReadContent(value) : renderText(args, value, caps.limit),
      // Text windows persist the structured line data (see the separate-mode
      // registration); an image read persists its path only, matching
      // `read_image`'s record.
      presentationMeta: (_args, value: ReadOutcome) => 'image' in value
        ? { path: value.path }
        : textReadMeta(value),
    },
    // Observation races fail closed because guarded mutations re-check the version in-lock;
    // image commits are content-addressed, so concurrent reads cannot conflict either.
    isConcurrencySafe: () => true,
    async execute(args: ReadArgs, exec): Promise<ReadOutcome> {
      const input = parseReadArgs(args, caps.limit)
      // The routing decision is the extension alone, so a declared image
      // refuses pagination arguments before any filesystem or attachment I/O.
      if (imageMediaTypeForPath(input.filePath) !== undefined) {
        if (args.offset !== undefined || args.limit !== undefined) {
          throw new Error('offset and limit are text-read arguments; image reads do not accept them')
        }
        return readImageFile(ctx, exec, input.filePath, 'read')
      }
      return readText(exec, input)
    },
    presentCall,
    presentResult,
  }))
}
