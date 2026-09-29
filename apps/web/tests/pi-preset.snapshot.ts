import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/pi-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const PROMPT = 'Use the read tool to read note.md, then use the read tool again to read dot.png. Then reply exactly PI_PRESET_REQUEST_OK and stop.'
/** The platform shell pi mounts: pwsh on Windows, bash everywhere else. */
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

/** Rendered text of the system prompt surface node, or undefined when the surface carries none. */
function systemPromptText(session: Session): string | undefined {
  const message = session.deriveMessages().find(candidate => candidate.role === 'system')
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('pi agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true, paceMs: 10 })
    // The recorded reads target these two files, so they exist before the turn.
    await writeFile(join(scaffold.workspaceCwd, 'note.md'), 'pi line one\npi line two\n')
    await writeFile(join(scaffold.workspaceCwd, 'dot.png'), PNG_1X1)
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('pi-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'pi' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'pi').then(() => undefined),
    })
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'pi preset smoke teardown failed')
  })

  it('sends exactly the four pi tools and reads text and one image through read', async () => {
    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the pi agent issued no model request')
    const systemPrompt = systemPromptText(agentHandle.agent.session)
    if (systemPrompt === undefined) throw new Error('the pi agent issued no system prompt')

    // The whole operation space: read/write/edit plus the platform shell, and
    // the integrated read carries the image capability; the shell is
    // foreground-only, so run_in_background never advertises.
    expect(requestHeader.tools?.map(tool => tool.name).sort()).toEqual(['edit', 'read', 'write', SHELL].sort())
    expect(requestHeader.tools?.find(tool => tool.name === 'read')?.description).toContain('PNG/JPEG/WebP/GIF')
    const shellProperties = requestHeader.tools?.find(tool => tool.name === SHELL)?.parameters.properties
    const shellPropertyNames = shellProperties !== undefined && shellProperties !== null
      ? Object.keys(shellProperties)
      : []
    expect(shellPropertyNames).not.toContain('run_in_background')
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))

    // Standard identity and working-directory context survive the pi persona;
    // guidance for tools pi does not mount never registers.
    expect(systemPrompt).toContain('You are a coding agent powered by the')
    expect(systemPrompt).toContain('Your working directory is')
    expect(systemPrompt).toContain('Ask the user questions as a normal reply')
    expect(systemPrompt).not.toContain('todo_write')

    // The recorded reads: one text window and one image, both through `read`.
    const readResults = agentHandle.agent.session.snapshotEvents()
      .flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
    const texts = readResults.map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join(''))
    expect(texts[0]).toContain('pi line one')
    const imageBlocks = readResults.flatMap(message => message.content
      .flatMap(block => block.type === 'image' ? [block] : []))
    expect(imageBlocks).toHaveLength(1)

    // The remaining three tools work through the live registry: one create,
    // one exact edit, and one foreground shell command.
    const signal = new AbortController().signal
    const execute = (name: string, args: Record<string, unknown>) => scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId(`pi-direct-${name}`),
      name,
      arguments: args,
      agent: agentHandle.agent,
    })
    await execute('write', { file_path: 'made.md', content: 'made by pi\n' })
    const edited = await execute('edit', { file_path: 'made.md', old_string: 'by pi', new_string: 'by the edit tool' })
    expect(edited.isError).toBe(false)
    const read = await execute('read', { file_path: 'made.md' })
    const readText = read.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
    expect(readText).toContain('made by the edit tool')
    const shell = await execute(SHELL, { command: 'echo PI_DIRECT_OK', description: 'Echo the pi marker' })
    const shellText = shell.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
    expect(shell.isError).toBe(false)
    // The exit-status marker is the shell tool's own tested behavior; the
    // foreground command's output is what the four-tool flow needs.
    expect(shellText).toContain('PI_DIRECT_OK')
  })

  it.skipIf(MODE === 'record')('expands the pi reads in the Web conversation, image gallery included', async () => {
    onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-pi-preset-read-cards') })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText('PI_PRESET_REQUEST_OK', { exact: true }).waitFor({ timeout: 15_000 })

    // Each read is its own step-process group; expand the turn process, every
    // read group, then each read row inside it. The text read carries the line
    // window; the image read carries the durable gallery image beside its
    // envelope.
    const process = page.locator('[data-turn-process]')
    await process.waitFor({ timeout: 15_000 })
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('false')
    await process.click()
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('true')

    // Consecutive reads share one "Read files" process group whose control
    // expands to both read rows.
    const readControls = page.locator('[data-process-activity="read"]')
    await readControls.first().waitFor({ timeout: 15_000 })
    for (const control of await readControls.all()) {
      await expect.poll(() => control.getAttribute('aria-expanded')).toBe('false')
      await control.click()
      await expect.poll(() => control.getAttribute('aria-expanded')).toBe('true')
    }

    const rows = page.locator('[data-variant="read"]')
    expect(await rows.count()).toBe(2)
    for (const row of await rows.all()) {
      // The expand toggle is the disclosure summary inside the row container.
      const toggle = row.locator('[data-expandable]')
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    }
    await page.getByText('pi line one').waitFor({ timeout: 15_000 })
    try {
      await page.getByRole('img', { name: 'dot.png' }).waitFor({ timeout: 15_000 })
    } catch (error) {
      const debug = await page.locator('[data-variant="read"]').evaluateAll(nodes => nodes.map(node => node.outerHTML).join('\n'))
      throw new Error(`pi image gallery debug:\n${debug}`, { cause: error })
    }

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v4.jsonl',
      'ui.expected.md',
    ])
  })
})
