import { app, BrowserWindow, clipboard, dialog, Menu, net, protocol, session, webContents, type MessageBoxOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { events, type EventName, type EventPayload } from '../shared/ipc/channels'
import { AgentService } from './application/agents'
import { GroupRegistry } from './application/groups'
import { closeAgent, closeTerminals } from './application/closeTerminals'
import { assertNotStarting, endProject } from './application/switchProject'
import { connectSquad, createSquad } from './application/createSquad'
import { FlowEngine } from './application/flow'
import { LoopEngine, remapLoops } from './application/loops'
import { HandoffService, type Handoff } from './application/handoff'
import type { Loop, SavedLoop } from './domain/loop'
import { SqliteLoopRepo } from './infrastructure/db/loops'
import { callTool, toolList, type ToolDeps } from './application/mcpTools'
import { agentCost, AGENT_BYTES, RESERVE_BYTES, Slots, spawnMany } from './application/spawnMany'
import { SquadSpawner, type SpawnQuestion } from './application/spawnAgent'
import { SquadRegistry } from './application/squads'
import { TaskBoard } from './application/tasks'
import { AgentError, type Agent, type ConfirmDiscard, type RemovalOutcome, type Repo } from './domain/agent'
import type { Edge } from './domain/edge'
import { cleanLine } from './domain/task'
import { hasTerminals, type RestoreChoice, type SavedBoard } from './domain/board'
import { acceptLayout, buildSnapshot, type Pending, restoreNotice, sanitizeBoard, savedAgentProblem, staleWorkspaces, type Layout } from './application/board'
import { boardView, discardWorktrees, layoutOf, restoreBoard, type Restored } from './application/restore'
import { agentMemory, MemoryService } from './application/memory'
import { SqliteBoardRepo } from './infrastructure/db/board'
import { SqliteMemoryRepo } from './infrastructure/db/memory'
import { REASON_MAX } from '../shared/flow'
import { annotationList, IMAGE_MAX_BYTES, type Annotation } from '../shared/annotation'
import { LIVE_HARD_MAX, LIVE_LIMIT_MIN, WORKSPACES_MAX } from '../shared/agent'
import { ImageError } from './domain/image'
import { ImageStore, readPicked } from './infrastructure/images'
import { SqliteAnnotationRepo } from './infrastructure/db/annotations'
import { buildDiagnostics } from './diagnostics'
import { PresetService, type Preset } from './domain/preset'
import { ClaudeAdapter } from './infrastructure/adapters/claude'
import { claudeProjectsDir, hasTranscript } from './infrastructure/adapters/transcript'
import { openDatabase } from './infrastructure/db/database'
import { SqliteSettingsRepo } from './infrastructure/db/settings'
import { SqlitePresetRepo } from './infrastructure/db/presets'
import { WorktreeService } from './infrastructure/git/worktree'
import { HookListener, pickBaseDir } from './infrastructure/hooks/listener'
import { HookService, removeStaleSettings } from './infrastructure/hooks/settings'
import { McpService } from './infrastructure/mcp/config'
import { McpServer } from './infrastructure/mcp/server'
import { PAUSED_MESSAGE, PtyManager } from './infrastructure/pty/manager'
import { spawnNodePty } from './infrastructure/pty/nodePty'
import { availableBytes, sessionRssBy, totalBytes } from './infrastructure/pty/session'
import { which } from './infrastructure/which'
import { handle } from './ipc/router'
import { IpcError } from './ipc/validate'
import { buildCsp, buildWebPreferences, isAllowedNavigation, isMicrophoneAllowed, resolveAppPath } from './security'
import { previewCommand, sendCommand } from './application/commands'
import { whisperFromEnv } from './infrastructure/stt/whisper'
import { exitCodeOf, isTileContents, recentFailures, recordFailure, WebTileManager } from './infrastructure/webtiles'
import { childType, goneReason } from './domain/webtile'
import { SqliteWebTileRepo, type SavedTile } from './infrastructure/db/webtiles'
import { normalizeAddress, WebTileError } from './domain/webtile'
import { UrlSuggester } from './domain/urlsuggest'
import { WEBTILES_MAX, type PageWidth } from '../shared/webtile'

// Test-only override of the data directory; ignored in packaged builds.
const userDataOverride = process.env['NODSHELL_USER_DATA']
if (!app.isPackaged && userDataOverride && isAbsolute(userDataOverride)) app.setPath('userData', userDataOverride)

// Test-only: a fake microphone that plays this WAV file (Chromium switches must be set before ready); ignored in packaged builds.
const fakeMic = process.env['NODSHELL_TEST_FAKE_MIC']
if (!app.isPackaged && fakeMic && isAbsolute(fakeMic)) {
  for (const sw of ['use-fake-device-for-media-stream', 'use-fake-ui-for-media-stream']) app.commandLine.appendSwitch(sw)
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMic)
}

// Test-only: milliseconds per second of every loop timer (schedule, idle count, output cooldown); ignored in packaged builds.
const loopMs = Number(app.isPackaged ? undefined : process.env['NODSHELL_TEST_LOOP_MS'])
const LOOP_MS_PER_SEC = Number.isInteger(loopMs) && loopMs >= 1 && loopMs <= 1000 ? loopMs : 1000

const devUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged && !!devUrl
// one WebGL context per terminal: Chromium's default of 16 is below the terminal limit (LIVE_HARD_MAX)
app.commandLine.appendSwitch('max-active-webgl-contexts', '64')
const appOrigin = isDev && devUrl ? new URL(devUrl).origin : 'app://app'
const rendererDir = join(__dirname, '../renderer')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Covers every webContents, present and future. A web tile's page has its own, stricter rules (http and https only; see WebTileManager).
app.on('web-contents-created', (_e, contents) => {
  const guard = (e: { preventDefault(): void }, url: string) => {
    if (!isTileContents(contents) && !isAllowedNavigation(url, appOrigin)) e.preventDefault()
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

/** Only short, path-free messages reach the renderer. */
async function safe<T>(fallback: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw new IpcError(e instanceof IpcError || e instanceof AgentError || e instanceof ImageError || e instanceof WebTileError ? e.message : fallback)
  }
}

function windowOf(senderId: number): BrowserWindow | null {
  const wc = webContents.fromId(senderId)
  return wc ? BrowserWindow.fromWebContents(wc) : null
}

/** Native dialog in main; "Keep" is the default and also what Esc or closing the dialog means. */
function confirmFor(senderId: number): ConfirmDiscard {
  return async (wt, commits) => {
    const opts: MessageBoxOptions = {
      type: 'warning',
      buttons: ['Keep', 'Discard'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Uncommitted work',
      message: `${wt.branch} has uncommitted changes${commits ? ` and ${commits} commit(s)` : ''}.`,
      detail: `Keep leaves the worktree and the branch in place:\n${wt.path}\n\nDiscard deletes both permanently.`,
    }
    const win = windowOf(senderId)
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return r.response === 1 ? 'discard' : 'keep'
  }
}

// Test-only: scripted answers ("yes"/"no", comma separated, the last one repeats) instead of the close dialog; ignored in packaged builds.
const closeAnswers = app.isPackaged ? [] : (process.env['NODSHELL_TEST_CLOSE'] ?? '').split(',').filter((a) => a === 'yes' || a === 'no')
let closeAsked = 0

/** Native dialog before stopping a live process; "Keep running" is the default and also what Esc or closing the dialog means. */
async function confirmClose(senderId: number, message: string, detail: string): Promise<boolean> {
  if (closeAnswers.length > 0) return closeAnswers[Math.min(closeAsked++, closeAnswers.length - 1)] === 'yes'
  const opts: MessageBoxOptions = { type: 'warning', buttons: ['Keep running', 'Close'], defaultId: 0, cancelId: 0, noLink: true, title: 'Close', message, detail }
  const win = windowOf(senderId)
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response === 1
}

// Test-only: scripted answers ("yes"/"no", comma separated, the last one repeats) instead of the spawn_agent dialog; ignored in packaged builds.
const spawnAnswers = app.isPackaged ? [] : (process.env['NODSHELL_TEST_SPAWN'] ?? '').split(',').filter((a) => a === 'yes' || a === 'no')
let spawnAsked = 0
/** Unanswered this long, the spawn dialog closes as denied (below the MCP relay's own reply timeout). */
const SPAWN_ASK_MS = 90_000

/** Native dialog before an Orchestrator starts an agent; "Deny" is the default and also what Esc, closing or no answer means. Plain text only. */
async function confirmSpawn(ownerId: number, q: SpawnQuestion): Promise<boolean> {
  if (spawnAnswers.length > 0) return spawnAnswers[Math.min(spawnAsked++, spawnAnswers.length - 1)] === 'yes'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SPAWN_ASK_MS)
  const opts: MessageBoxOptions = {
    type: 'question',
    buttons: ['Deny', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Start an agent?',
    message: `${q.orchestrator} (Orchestrator) wants to start a ${q.preset} agent.`,
    detail: `Model: ${q.model}\n\nIts first task:\n${q.task}\n\nAllow only if you expect this. It gets its own worktree and joins the squad.`,
    signal: ac.signal,
  }
  try {
    const win = windowOf(ownerId)
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return r.response === 1
  } finally {
    clearTimeout(timer)
  }
}

// Test-only: scripted answer ("yes"/"no") instead of the leave dialog; ignored in packaged builds.
const leaveAnswer = app.isPackaged ? undefined : process.env['NODSHELL_TEST_LEAVE']

/** Native dialog before closing the window or quitting would stop live agents or programs; "Keep running" is the default. */
async function confirmLeave(win: BrowserWindow | null): Promise<boolean> {
  if (leaveAnswer === 'yes' || leaveAnswer === 'no') return leaveAnswer === 'yes'
  const opts: MessageBoxOptions = { type: 'warning', buttons: ['Keep running', 'Close'], defaultId: 0, cancelId: 0, noLink: true, title: 'Close', message: 'Close NodShell?', detail: 'Agents or programs are still running and will be stopped.' }
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response === 1
}

// Test-only: the memory the system reports as available, in MiB; ignored in packaged builds.
const testAvailMb = app.isPackaged ? NaN : Number(process.env['NODSHELL_TEST_AVAIL_MB'] ?? NaN)
const availBytes = () => (Number.isFinite(testAvailMb) ? testAvailMb * 2 ** 20 : availableBytes())

// Test-only: scripted answer ("resume"/"choose"/"fresh"/"empty") instead of the restore dialog; ignored in packaged builds.
const restoreAnswer = app.isPackaged ? undefined : process.env['NODSHELL_TEST_RESTORE']

/** Native dialog when a project with a saved board opens; "Resume conversations" is the default and also what Esc means. */
async function askRestore(senderId: number, terminals: number): Promise<RestoreChoice> {
  if (restoreAnswer === 'resume' || restoreAnswer === 'choose' || restoreAnswer === 'fresh' || restoreAnswer === 'empty') return restoreAnswer
  const opts: MessageBoxOptions = {
    type: 'question',
    buttons: ['Resume conversations', 'Choose terminals…', 'Start fresh', 'Empty board'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Saved board',
    message: `This project has a saved board with ${terminals} terminal${terminals === 1 ? '' : 's'}.`,
    detail: 'Resume conversations relaunches each agent in its own worktree and continues its session. Choose terminals lets you pick which ones come back; the rest stay saved. Start fresh relaunches them with new sessions. Empty board discards the saved board and cleans up the agent worktrees (uncommitted work is only discarded if you confirm).',
  }
  const win = windowOf(senderId)
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return (['resume', 'choose', 'fresh', 'empty'] as const)[r.response] ?? 'resume'
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0a0a0b',
    icon: join(__dirname, '../renderer/icon.png'), // taskbar and window switcher, also when run without a desktop entry (AppImage)
    webPreferences: buildWebPreferences(join(__dirname, '../preload/index.js')),
  })
  // tests read terminal text from the page, which only the DOM renderer provides
  const dom = !app.isPackaged && process.env['NODSHELL_TEST_DOM'] === '1' ? '?renderer=dom' : ''
  void win.loadURL(isDev && devUrl ? devUrl : `app://app/index.html${dom}`)
}

void app.whenReady().then(async () => {
  // no default menu in a build: it brings zoom (which would move web tiles over the chrome), reload and the DevTools shortcuts
  if (!isDev) Menu.setApplicationMenu(null)
  const csp = buildCsp(isDev, isDev ? appOrigin : undefined)
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  // everything is denied except the microphone (audio only) for the app's own window at the app's own origin
  // a web tile's page is never the app window (it also lives in its own session, where everything is denied)
  const ownWindow = (wc: Electron.WebContents | null) => wc !== null && !isTileContents(wc) && BrowserWindow.getAllWindows().some((w) => w.webContents === wc)
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) =>
    cb(isMicrophoneAllowed(perm, 'mediaTypes' in details ? details.mediaTypes : undefined, details.requestingUrl, appOrigin) && ownWindow(wc)),
  )
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin, details) =>
    isMicrophoneAllowed(perm, 'mediaType' in details && details.mediaType ? [details.mediaType] : undefined, origin, appOrigin) && ownWindow(wc),
  )

  // Board images: stored copies, served by id only (a UUID, resolved inside their own directory), typed from their bytes
  const images = new ImageStore(join(app.getPath('userData'), 'board-images'))
  const IMAGE_PATH = '/board-image/'
  // Serves the built renderer from disk; no remote content in production.
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url)
    if (pathname.startsWith(IMAGE_PATH)) {
      const img = await images.read(pathname.slice(IMAGE_PATH.length))
      const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' }
      return img ? new Response(new Uint8Array(img.data), { headers: { ...headers, 'Content-Type': img.info.mime } }) : new Response('Not found', { status: 404, headers })
    }
    const r = resolveAppPath(pathname, rendererDir)
    if (!r.ok) return new Response('Bad request', { status: 400 })
    return net.fetch(pathToFileURL(r.file).toString())
  })

  const send = <E extends EventName>(ownerId: number, event: E, payload: EventPayload<E>) => {
    const wc = webContents.fromId(ownerId)
    // events are validated before they leave main
    if (wc && !wc.isDestroyed()) wc.send(event, events[event].parse(payload))
  }
  const tiles = new WebTileManager(
    {
      state: (o, st) => send(o, 'webtile:changed', st),
      returned: (o, id) => send(o, 'webtile:returned', { id }),
      changed: () => persist(),
    },
    randomUUID,
  )
  // offers to open a localhost address a terminal printed; not when the window is at the tile limit or has a tile there already
  const suggester = new UrlSuggester(Date.now, (ownerId, address) => {
    if (tiles.count(ownerId) >= WEBTILES_MAX) return false
    const host = new URL(address).host
    return !tiles.list(ownerId).some((t) => {
      try {
        return new URL(t.url).host === host
      } catch {
        return false
      }
    })
  })
  const ptys = new PtyManager((ownerId, event, payload) => {
    send(ownerId, event, payload)
    if (event === 'pty:data') {
      const { id, data } = payload as EventPayload<'pty:data'>
      loops.onOutput(ownerId, id, data)
      const address = suggester.feed(ownerId, id, data)
      if (address) send(ownerId, 'webtile:suggest', { terminalId: id, address })
    }
    if (event === 'pty:exit') {
      const { id, code } = payload as EventPayload<'pty:exit'>
      suggester.forget(id)
      agents.signal(id, { type: 'exited', code })
    }
  }, spawnNodePty)
  const gitPath = which('git', process.env['PATH'])
  const worktrees = new WorktreeService(gitPath ?? '', join(app.getPath('userData'), 'worktrees'))
  // Hook socket on a short private path; without it agents cannot report status, so spawning them is refused.
  const hookListener = await Promise.resolve()
    .then(() => HookListener.start(pickBaseDir([process.env['XDG_RUNTIME_DIR'], tmpdir(), '/tmp'])))
    .catch(() => null)
  app.on('will-quit', () => hookListener?.close())
  const relayPath = join(__dirname, 'hook-relay.js')
  const settingsDir = join(app.getPath('userData'), 'agents')
  removeStaleSettings(settingsDir) // no agent exists yet
  const hooks = new HookService(existsSync(relayPath) ? hookListener : null, settingsDir, process.execPath, relayPath)
  // MCP bridge: its socket sits next to the hook socket, in the same private directory; without it agents still run, without the tools
  const mcpRelayPath = join(__dirname, 'mcp-relay.js')
  // only an Orchestrator sees spawn_agent; its role is known from its spawn, before it ever lists the tools
  const isOrchestrator = (agentId: string): boolean => agents.byId(agentId)?.role === 'orchestrator'
  const mcpServer = hookListener && existsSync(mcpRelayPath)
    ? await McpServer.start(join(hookListener.dir, 'mcp.sock'), { list: (agentId: string) => toolList(isOrchestrator(agentId)), call: (agentId, name, args) => callTool(toolDeps, agentId, name, args) }).catch(() => null)
    : null
  app.on('will-quit', () => mcpServer?.close())
  const agents = new AgentService({
    adapter: new ClaudeAdapter(),
    worktrees,
    ptys,
    hooks,
    mcp: mcpServer ? new McpService(mcpServer, settingsDir, process.execPath, mcpRelayPath) : undefined,
    onState: (ownerId, id, state, statusUnavailable) => {
      if (state === 'exited' || state === 'error') tasks.down(id)
      loops.onState(ownerId, id, state)
      handoffs.onState(ownerId, id, state)
      send(ownerId, 'agent:state', { id, state, statusUnavailable, at: Date.now() })
      persist()
    },
    // a submission the app did not inject came from the user, in the terminal: the Orchestrator may ask to spawn again
    onPromptSubmit: (_o, id) => {
      const n = injected.get(id) ?? 0
      if (n > 0) injected.set(id, n - 1)
      else spawner.userPrompted(id)
    },
    onIdle: (ownerId, id, byStop) => {
      if (byStop) tasks.stopped(id) // before anything waiting is delivered on this same Stop
      void loops.onIdle(ownerId, id, byStop) // its run is counted and its goal read before the loop may fire again
      void handoffs.onIdle(ownerId, id, byStop) // a handoff's summary is read on this Stop; the flow engine muted it (no edge fires)
      void flow.onIdle(ownerId, id, byStop)
    },
    onSession: () => persist(),
  })
  let sttOwner: number | null = null // the window whose transcription is running (one at a time)
  let repo: Repo | null = null // the open project; reopened at the next start from the database
  const injected = new Map<string, number>() // per agent: app deliveries whose UserPromptSubmit has not come back yet
  const groups = new GroupRegistry((ownerId, id) => ptys.owns(ownerId, id), randomUUID)
  const squads = new SquadRegistry(randomUUID)
  let perAgentBytes = AGENT_BYTES // measured by reportMemory
  const slots = new Slots(() => ptys.size, () => ptys.limit, availBytes, Date.now, () => perAgentBytes)
  const reasonText = (r: string) => cleanLine(r).slice(0, REASON_MAX) // reasons may name what an agent sent; shown in toasts and the editor
  const edgeDto = (e: Edge) => ({ id: e.id, workspaceId: e.workspaceId, source: { ...e.source }, target: { ...e.target }, template: e.template, condition: e.condition, paused: e.paused === null ? null : reasonText(e.paused), note: e.note === null ? null : reasonText(e.note) })
  const flowState = (o: number) => send(o, 'flow:changed', { edges: flow.list(o).map(edgeDto), paused: ptys.isStopped(o), flowsPaused: flow.flowsPaused(o) })
  const tasks = new TaskBoard((o, s) => {
    try {
      send(o, 'tasks:changed', s)
    } catch {
      // a display update never gets in the way of a delivery (it runs inside the queue)
    }
  }, randomUUID)
  const flow = new FlowEngine(
    {
      agent: (o, id) => agents.get(o, id),
      group: (o, id) => groups.get(o, id),
      groupOf: (id) => groups.groupOf(id),
      squad: (o, id) => squads.get(o, id),
      // only the reply itself, from the transcript: a scrape of the terminal is never passed on to another agent
      lastMessage: (o, id) => agents.turnReply(o, id),
      readiness: (o, id) => (ptys.isStopped(o) ? { refused: 'is paused' } : agents.readiness(o, id)),
      // Pause all is checked again inside the PTY's queue, before the paste and before the Enter
      // each delivery is one submission the CLI will report: counted, so it is never taken for the user's own prompt
      deliver: async (o, id, text) => {
        injected.set(id, (injected.get(id) ?? 0) + 1)
        try {
          await agents.inject(o, id, text, () => (ptys.isStopped(o) ? 'is paused' : null))
        } catch (e) {
          injected.set(id, Math.max(0, (injected.get(id) ?? 1) - 1))
          throw e
        }
      },
      now: Date.now,
      emit: (o, e) => {
        if (e.type === 'changed') {
          flowState(o)
          persist()
        } else if (e.type === 'fired') send(o, 'flow:fired', { id: e.id })
        else send(o, 'flow:paused', { id: e.id, reason: reasonText(e.reason) })
      },
      // tags are task ids or loop ids (UUIDs); each side ignores the others'
      track: (id, tags, e) => {
        tasks.track(id, tags, e)
        loops.track(id, tags, e)
      },
    },
    randomUUID,
  )
  const loopDto = (l: Loop) => ({ id: l.id, workspaceId: l.workspaceId, agentId: l.agentId, prompt: l.prompt, trigger: { ...l.trigger }, goal: l.goal, maxRuns: l.maxRuns, runs: l.runs, state: l.state, reason: l.reason === null ? null : reasonText(l.reason) })
  const savedLoop = ({ id, workspaceId, agentId, prompt, trigger, goal, maxRuns }: Loop): SavedLoop => ({ id, workspaceId, agentId, prompt, trigger: { ...trigger }, goal, maxRuns })
  const loops = new LoopEngine(
    {
      agent: (o, id) => agents.get(o, id),
      hasTerminal: (o, id) => ptys.owns(o, id),
      // an agent knows its workspace; a console's is the renderer's last layout (of the open project)
      workspaceOf: (o, id) => agents.get(o, id)?.workspaceId ?? (ptys.owns(o, id) && (target === null || target.ownerId === o) ? layout?.nodes.find((n) => n.id === id)?.workspaceId : undefined),
      // only the reply itself, from the transcript (a scrape of the screen would also show the prompt, goal included)
      lastMessage: (o, id) => agents.turnReply(o, id),
      fire: (o, id, text, tag) => flow.loopPrompt(o, id, text, tag),
      withdraw: (id, tag) => flow.withdraw(id, tag),
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      emit: (o, e) => {
        if (e.type === 'changed') {
          send(o, 'loop:changed', { loops: loops.list(o).map(loopDto) })
          persist()
        } else send(o, 'loop:notice', { text: cleanLine(e.text).slice(0, REASON_MAX + 100) })
      },
    },
    randomUUID,
    LOOP_MS_PER_SEC,
  )
  const handoffDto = ({ id, workspaceId, fromId, toId, state, briefing }: Handoff) => ({ id, workspaceId, fromId, toId, state, briefing })
  const handoffs = new HandoffService(
    {
      agent: (o, id) => {
        const a = agents.get(o, id)
        return a && { id: a.id, name: a.name, role: a.role, branch: a.worktree.branch, state: a.state, workspaceId: a.workspaceId }
      },
      // the user clicked Hand off: a user prompt (new chain), but written only while the agent rests, checked again before the
      // paste and before the Enter (as a flow's delivery), so no other turn's Stop is ever read as the briefing
      ask: async (o, id, text) => {
        notPaused(o)
        flow.userPrompt(id)
        spawner.userPrompted(id)
        flow.muteNextStop(o, id) // before the Enter: the briefing's Stop must find it
        try {
          await agents.inject(o, id, text, () => (ptys.isStopped(o) ? 'is paused' : null))
        } catch (e) {
          flow.unmute(id)
          throw e instanceof AgentError ? new AgentError(`${agents.get(o, id)?.name ?? 'The agent'} ${e.message}`) : e
        }
      },
      pending: (_o, id) => flow.pending(id),
      release: (o, id) => {
        if (agents.get(o, id)?.state === 'idle') flow.unmute(id)
      },
      // only the reply itself, from the transcript (a scrape of the screen would also show the request)
      lastMessage: (o, id) => agents.turnReply(o, id),
      // the flow engine's queue: a new chain, written only while the agent rests, held while paused, counted by the burst guard
      deliver: (o, id, text, tag) => flow.loopPrompt(o, id, text, tag),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      // the briefing goes only to the window that owns the handoff; never logged
      emit: (o, e) => send(o, 'handoff:changed', { handoffs: handoffs.list(o).map(handoffDto), notice: e.notice ? cleanLine(e.notice).slice(0, REASON_MAX + 100) : null }),
    },
    randomUUID,
  )
  const peer = (a: Readonly<Agent>) => ({ id: a.id, ownerId: a.ownerId, workspaceId: a.workspaceId, name: a.name, role: a.role, state: a.state })
  const toolDeps: ToolDeps = {
    agent: (id) => {
      const a = agents.byId(id)
      return a && peer(a)
    },
    agents: (o) => agents.list(o).map(peer),
    groups: (o) => groups.list(o),
    squads: (o) => squads.list(o),
    groupOf: (id) => groups.groupOf(id),
    lastMessage: async (o, id) => {
      const m = await agents.lastMessage(o, id)
      return m.source === 'scrape' ? `[best effort, scraped from the terminal]\n${m.text}` : m.text
    },
    report: (o, id, text) => {
      agents.setReport(o, id, text)
      send(o, 'agent:report', { id, text })
    },
    paused: (o) => ptys.isStopped(o),
    flow,
    tasks,
    spawn: (me, input) => spawner.spawn(me, input),
    // the agent's own repository, never the one open in the window; nothing is sent to any console because of it
    memory: {
      read: (me, scope) => mem().read(me, scope),
      write: (me, scope, content, mode) => mem().write(me, scope, content, mode),
    },
  }
  const spawner = new SquadSpawner({
    presets: { list: () => needPresets().list() },
    agents,
    groups,
    squads,
    slots,
    flow,
    tasks,
    repo: () => repo,
    paused: (o) => ptys.isStopped(o),
    confirm: confirmSpawn,
    joined: (o, j) => {
      send(o, 'squad:spawned', j)
      persist()
    },
  })
  /** A card is gone: its group membership, the squad it led and every edge that lost an end. */
  const forgetCard = (o: number, id: string) => {
    spawner.forget(id)
    injected.delete(id)
    groups.forget(id)
    const led = squads.forget(id)
    if (led) tasks.dropSquad(led.id)
    tasks.down(id)
    flow.prune(o)
    loops.prune(o)
    handoffs.prune(o)
    persist()
  }
  const notPaused = (o: number) => {
    if (ptys.isStopped(o)) throw new AgentError(PAUSED_MESSAGE)
  }
  // Presets, memory and boards live in SQLite under the user-data dir (0700, file 0600); without the database they are unavailable but the rest of the app works.
  const db = await Promise.resolve()
    .then(() => {
      mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
      const d = openDatabase(join(app.getPath('userData'), 'nodshell.db'))
      app.on('will-quit', () => d.close())
      return d
    })
    .catch(() => null)
  const presets = db && new PresetService(new SqlitePresetRepo(db), randomUUID)
  const memory = db && new MemoryService(new SqliteMemoryRepo(db))
  const boards = db && new SqliteBoardRepo(db)
  const annotations = db && new SqliteAnnotationRepo(db)
  const webTileRepo = db && new SqliteWebTileRepo(db)
  const loopRepo = db && new SqliteLoopRepo(db)
  const settings = db && new SqliteSettingsRepo(db)
  try {
    const saved = Number(settings?.get('liveLimit'))
    if (Number.isInteger(saved) && saved >= LIVE_LIMIT_MIN && saved <= LIVE_HARD_MAX) ptys.limit = saved
  } catch {
    // the default stays
  }
  try {
    if (annotations) images.cleanup(annotations.imageIds()) // files nobody refers to any more
  } catch {
    // tried again at the next start
  }
  const needPresets = () => presets ?? (() => { throw new AgentError('Presets are unavailable') })()
  const needMemory = () => memory ?? (() => { throw new AgentError('Memory is unavailable') })()
  const agentMem = memory && agentMemory(memory, { rootOf: (id) => agents.byId(id)?.worktree.repoRoot ?? null, charge: (o) => flow.charge(o), changed: (o, scope, v, by) => send(o, 'memory:changed', { scope, updatedAt: v.updatedAt ?? Date.now(), updatedBy: by }) })
  const mem = () => agentMem ?? (() => { throw new AgentError('Memory is unavailable') })()

  // Board persistence: main saves what it knows (agents, groups, squads, edges) with the renderer's last layout, for the open
  // project only, shortly after each change. Detached while a project is left or restored, so a board being torn down or still
  // coming back never overwrites the saved one.
  let target: { ownerId: number; root: string } | null = null
  let layout: Layout | null = null
  let pending: Pending | undefined // saved agents that did not come back: kept on the saved board
  let pendingLoops: SavedLoop[] = [] // their loops, saved again as they were
  let saveTimer: NodeJS.Timeout | undefined
  let restoring = false
  const known = (o: number, id: string) => agents.has(o, id) || ptys.owns(o, id) || !!groups.get(o, id) || !!squads.get(o, id) || tiles.owns(o, id)
  const snapshot = (o: number) =>
    buildSnapshot({ agents: agents.list(o), consoles: ptys.idsOf(o).filter((id) => !agents.has(o, id)), groups: groups.list(o), squads: squads.list(o), edges: flow.list(o), layout, pending }, randomUUID)
  /** each tile of the window with its address (main's) and its place (the renderer's last layout) */
  const savedTiles = (o: number): SavedTile[] =>
    tiles.list(o).map((t) => {
      const l = layout?.nodes.find((n) => n.id === t.id)
      return { id: t.id, workspaceId: l?.workspaceId ?? t.workspaceId, url: t.url, x: l?.x ?? 0, y: l?.y ?? 0, w: l?.w ?? 0, h: l?.h ?? 0, pageWidth: t.pageWidth }
    })
  const persistNow = () => {
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (!target || !boards) return
    try {
      boards.save(target.root, snapshot(target.ownerId))
      webTileRepo?.replace(target.root, savedTiles(target.ownerId))
      loopRepo?.replace(target.root, [...loops.list(target.ownerId).map(savedLoop), ...pendingLoops])
    } catch {
      // the next change tries again; nothing about the board is logged
    }
  }
  function persist(): void {
    if (target && !saveTimer) saveTimer = setTimeout(persistNow, 100)
  }
  const attach = (ownerId: number, root: string, l: Layout | null, p?: typeof pending) => {
    target = { ownerId, root }
    layout = l
    pending = p
    if (!p) pendingLoops = []
    try {
      boards?.touch(root) // the project reopened at the next start
    } catch {
      // still works for this session
    }
    persistNow()
  }
  const detach = () => {
    knownWs.clear()
    persistNow()
    target = null
    layout = null
    pending = undefined
    pendingLoops = []
  }
  // the last save before leaving waits (briefly) for the renderer's current layout
  const flushWaiters: (() => void)[] = []
  const flushLayout = (o: number) =>
    new Promise<void>((done) => {
      flushWaiters.push(done)
      setTimeout(done, 1000)
      send(o, 'board:flush', {})
    })
  const notRestoring = () => {
    if (restoring) throw new AgentError('Wait for the board to finish restoring')
  }
  const presetDto = ({ id, name, role, adapter, model, systemPrompt, builtin }: Preset) => ({ id, name, role, adapter, model, systemPrompt, builtin })

  app.on('web-contents-created', (_e, wc) =>
    wc.once('destroyed', () => {
      if (isTileContents(wc)) return // a web tile's page owns nothing: closing it never closes a window's terminals
      if (target?.ownerId === wc.id) detach() // saved as it was, before anything below takes it apart
      tiles.closeOwned(wc.id)
      if (sttOwner === wc.id) stt.abort() // its transcription has no one to answer
      groups.dropOwner(wc.id)
      squads.dropOwner(wc.id)
      tasks.dropOwner(wc.id)
      flow.dropOwner(wc.id)
      loops.dropOwner(wc.id)
      handoffs.dropOwner(wc.id)
      void agents.closeAll(wc.id)
      void ptys.killOwned(wc.id)
    }),
  )
  // Closing the window or quitting stops every live process, so it asks first, once; the answer covers the quit that follows a window close.
  let leaving = false
  let asking = false
  const mayLeave = async (win: BrowserWindow | null, ownerId?: number): Promise<boolean> => {
    if (leaving || !(agents.anyLive(ownerId) || ptys.anyBusy(ownerId))) return true
    if (asking) return false
    asking = true
    try {
      leaving = await confirmLeave(win)
    } finally {
      asking = false
    }
    return leaving
  }
  /** The board is saved for good (with the renderer's current layout) and no longer touched by what follows. */
  const saveForGood = async (ownerId?: number) => {
    if (target && (ownerId === undefined || target.ownerId === ownerId)) {
      await flushLayout(target.ownerId)
      detach()
    }
  }
  app.on('child-process-gone', (_e, d) => recordFailure({ kind: 'child', reason: goneReason(d.reason), exitCode: exitCodeOf(d), type: childType(d.type) }))
  app.on('browser-window-created', (_e, win) => {
    const ownerId = win.webContents.id
    // the page is replaced (reload) or its renderer died: its tile nodes are gone, so are their views
    win.webContents.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) {
        tiles.dropOwned(ownerId)
        handoffs.dropOwner(ownerId) // nothing of a handoff survives the page (no dialog would show it)
      }
    })
    win.webContents.on('render-process-gone', (_e, d) => {
      recordFailure({ kind: 'app-renderer', reason: goneReason(d.reason), exitCode: exitCodeOf(d) })
      tiles.dropOwned(ownerId)
    })
    win.on('close', (e) => {
      if (leaving) return
      e.preventDefault()
      void mayLeave(win, ownerId).then(async (ok) => {
        if (!ok || win.isDestroyed()) return
        leaving = true
        await saveForGood(ownerId)
        if (!win.isDestroyed()) win.close()
      })
    })
  })
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    void mayLeave(BrowserWindow.getFocusedWindow()).then(async (ok) => {
      if (!ok || quitting) return
      quitting = true
      leaving = true
      await saveForGood().catch(() => undefined)
      // agents first (stopped, no further dialog, never forced; their worktrees stay for the saved board), then any console
      return agents
        .closeAll()
        .then(() => ptys.killAll())
        .catch(() => undefined)
        .finally(() => app.quit())
    })
  })

  handle('ping', appOrigin, ({ message }) => ({ reply: `pong: ${message}`, at: Date.now() }))
  handle('pty:spawn', appOrigin, ({ cols, rows }, { senderId }) => {
    if (slots.freeOfLimit() < 1) throw new IpcError(`Terminal limit reached (${ptys.limit})`) // slots held by a running batch count too
    const r = ptys.spawn(senderId, cols, rows)
    persist()
    return r
  })
  handle('pty:write', appOrigin, ({ id, data }, { senderId }) => (ptys.write(senderId, id, data), { ok: true as const }))
  handle('pty:resize', appOrigin, ({ id, cols, rows }, { senderId }) => (ptys.resize(senderId, id, cols, rows), { ok: true as const }))
  handle('settings:get', appOrigin, () => ({ liveLimit: ptys.limit }))
  handle('settings:setLiveLimit', appOrigin, ({ limit }) => {
    try {
      settings?.set('liveLimit', String(limit))
    } catch {
      throw new IpcError('Could not save the setting')
    }
    ptys.limit = limit // lowering it kills nothing: only new terminals are refused
    return { liveLimit: limit }
  })
  handle('pty:ack', appOrigin, ({ id, bytes }, { senderId }) => (ptys.ack(senderId, id, bytes), { ok: true as const }))
  handle('pty:kill', appOrigin, async ({ id }, { senderId }) => {
    // only a shell that still runs a program asks; an idle one closes directly
    if (ptys.busy(senderId, id) && !(await confirmClose(senderId, 'Close this terminal?', 'A program is still running in it and will be stopped.'))) return { closed: false }
    await ptys.kill(senderId, id)
    forgetCard(senderId, id)
    return { closed: true }
  })

  const batchDeps = (senderId: number, keepWorktrees: boolean) => ({
    owns: (o: number, id: string) => agents.has(o, id) || ptys.owns(o, id),
    isAgent: (o: number, id: string) => agents.has(o, id),
    needsConfirm: (o: number, id: string) => agents.needsStop(o, id) || (ptys.owns(o, id) && ptys.busy(o, id)),
    closeAgent: (id: string) => (keepWorktrees ? agents.stop(senderId, id) : agents.close(senderId, id, confirmFor(senderId))),
    killPty: (id: string) => ptys.kill(senderId, id),
    forget: (id: string) => forgetCard(senderId, id),
  })
  /** One confirmation for the whole batch, then each terminal closes as it would alone. */
  const closeBatch = (senderId: number, ids: string[], message: string, detail: string) => closeTerminals(batchDeps(senderId, false), senderId, ids, () => confirmClose(senderId, message, detail))
  /** Leaving the project: one confirmation, then the board is saved for good and every terminal stops; agent worktrees stay for the saved board. */
  const leaveBatch = async (senderId: number, ids: string[]) => {
    const d = batchDeps(senderId, true)
    if (ids.some((id) => d.needsConfirm(senderId, id)) && !(await confirmClose(senderId, 'Open another folder?', 'Agents or programs are still running and will be stopped. The board is saved and comes back when you open this project again.'))) return { closed: false, kept: 0, archived: 0 }
    await saveForGood(senderId)
    return closeTerminals(d, senderId, ids, async () => true)
  }
  const starting = () => agents.spawning || slots.pending || restoring

  /**
   * A project was opened in this window: its saved board (if it has a terminal) comes back after one question, then the board is
   * saved as it goes. Resume and Start fresh relaunch everything they can; Empty board discards it and cleans up the worktrees.
   */
  /** The saved annotations of these workspaces; whatever does not validate or lost its image file is left out. */
  /** workspaces whose annotations the renderer has (were sent to it, or it saved them): only those may be pruned */
  const knownWs = new Set<string>()
  /** image ids this window got from main this session (a save may only use those or the open project's own) */
  const createdImages = new Map<number, Set<string>>()
  const loadAnnotations = (root: string, wsIds: ReadonlySet<string>): { workspaceId: string; items: Annotation[] }[] => {
    try {
      return [...(annotations?.load(root) ?? [])]
        .filter(([ws]) => wsIds.has(ws))
        .slice(0, WORKSPACES_MAX)
        .map(([workspaceId, items]) => ({ workspaceId, items: items.filter((a) => a.kind !== 'image' || images.has(a.imageId)) }))
        .filter((w) => w.items.length > 0 && annotationList.safeParse(w.items).success)
        .map((w) => (knownWs.add(w.workspaceId), w))
    } catch {
      return []
    }
  }
  // an image file goes only when no annotation of any project still refers to it
  const dropImages = (ids: string[]) => {
    if (!annotations || ids.length === 0) return
    try {
      const used = annotations.imageIds()
      images.remove(ids.filter((id) => !used.has(id.toLowerCase())))
    } catch {
      // the start-up cleanup gets them
    }
  }
  type ReopenedTile = { id: string; workspaceId: string; title: string; address: string; x: number; y: number; w: number; h: number; pageWidth: PageWidth | null }
  /** The project's saved web tiles in these workspaces, opened again (each address checked again first), within the window's limit. */
  const reopenTiles = (senderId: number, root: string, wsIds: ReadonlySet<string>): ReopenedTile[] => {
    let saved: SavedTile[]
    try {
      saved = webTileRepo?.load(root) ?? []
    } catch {
      return []
    }
    const win = windowOf(senderId)
    const out: ReopenedTile[] = []
    const fit = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0)
    for (const s of saved) {
      if (!win || tiles.count(senderId) >= WEBTILES_MAX) break
      if (!wsIds.has(s.workspaceId)) continue
      try {
        const t = tiles.create(senderId, win, s.workspaceId, normalizeAddress(s.url), s.pageWidth)
        out.push({ id: t.id, workspaceId: s.workspaceId, title: t.title, address: t.address, x: fit(s.x, -1_000_000, 1_000_000), y: fit(s.y, -1_000_000, 1_000_000), w: fit(s.w, 0, 100_000), h: fit(s.h, 0, 100_000), pageWidth: s.pageWidth })
      } catch {
        // not a valid address any more: dropped
      }
    }
    return out
  }
  const tileLayout = (ts: ReopenedTile[]) => ts.map(({ id, workspaceId, x, y, w, h }) => ({ id, workspaceId, x, y, w, h, pinned: false, collapsed: false }))
  const openBoard = async (senderId: number, r: Repo): Promise<{ board: ReturnType<typeof boardView<ReturnType<typeof edgeDto>>> | null; annotations: { workspaceId: string; items: Annotation[] }[]; webTiles: ReopenedTile[]; notice: string | null }> => {
    let loaded: SavedBoard | null
    try {
      loaded = boards?.load(r.root) ?? null
    } catch {
      loaded = null // unreadable: start empty
    }
    // nothing read back is trusted: malformed items are dropped before anything is relaunched
    const { board: saved, dropped } = loaded ? sanitizeBoard(loaded) : { board: null, dropped: 0 }
    const droppedNote = dropped > 0 ? `${dropped} saved item${dropped > 1 ? 's were' : ' was'} not valid and dropped.` : null
    const board0: SavedBoard | null = saved
    if (!hasTerminals(saved)) {
      // nothing to relaunch; but if something was drawn, its workspaces (ids, names, views) come back so the drawing has its board
      const wsIds = new Set(board0?.workspaces.map((w) => w.id) ?? [])
      const drawn = board0 ? loadAnnotations(r.root, wsIds) : []
      // opened before attach, whose first save writes the window's tiles
      const webTiles = board0 ? reopenTiles(senderId, r.root, wsIds) : []
      if (board0 && (drawn.length > 0 || webTiles.length > 0)) {
        const l = layoutOf(board0)
        l.nodes.push(...tileLayout(webTiles))
        attach(senderId, r.root, l)
        const empty: Restored = { cancelled: false, board: board0, agents: new Map(), consoles: new Map(), ids: new Map(), skipped: [], pending: { agents: [], nodes: [], groups: [], squads: [], edges: [] } }
        return { board: boardView(empty, []), annotations: drawn, webTiles, notice: droppedNote }
      }
      attach(senderId, r.root, null)
      return { board: null, annotations: [], webTiles: [], notice: droppedNote }
    }
    // the window is gone or the app is leaving: whatever happens next is not saved over the board on disk
    const cancelled = () => leaving || quitting || !webContents.fromId(senderId) || webContents.fromId(senderId)!.isDestroyed()
    const none = { board: null, annotations: [], webTiles: [], notice: null }
    // terminals (and web tiles) this window already has (e.g. a console opened before the project): they stay, on the restored active board
    const before = [...ptys.idsOf(senderId), ...groups.list(senderId).map((g) => g.id), ...tiles.ids(senderId)]
    restoring = true
    try {
      const choice = await askRestore(senderId, saved.nodes.filter((n) => n.kind === 'agent' || n.kind === 'console').length)
      if (cancelled()) return none
      const only = choice === 'choose' ? await chooseTerminals(senderId, saved) : undefined
      if (cancelled()) return none
      if (choice === 'empty') {
        const left = await discardWorktrees({ worktrees }, r, saved, confirmFor(senderId))
        if (cancelled()) return none
        boards?.clear(r.root)
        try {
          webTileRepo?.clear(r.root)
          loopRepo?.clear(r.root)
          dropImages(annotations?.clear(r.root) ?? [])
        } catch {
          // the rows go with the project's next save; the files with the start-up cleanup
        }
        attach(senderId, r.root, null)
        const parts = [left.kept > 0 && `${left.kept} agent worktree${left.kept > 1 ? 's' : ''} with uncommitted work kept`, left.archived > 0 && `${left.archived} agent branch${left.archived > 1 ? 'es' : ''} with commits kept`].filter(Boolean)
        const untouched = left.left.length ? ` Left as they are, check them yourself: ${left.left.map((x) => `${x.name} on ${x.branch} (${x.reason})`).join(', ')}.` : ''
        return { board: null, annotations: [], webTiles: [], notice: `Board emptied.${parts.length ? ` ${parts.join('; ')}.` : ''}${untouched}`.slice(0, 500) }
      }
      let savedLoops: SavedLoop[] = []
      try {
        savedLoops = loopRepo?.load(r.root) ?? [] // read before the first save of the restored board replaces them
      } catch {
        // unreadable: the loops do not come back
      }
      const home = process.env['HOME'] && isAbsolute(process.env['HOME']) ? process.env['HOME'] : homedir()
      const projects = claudeProjectsDir(process.env, home)
      const res = await restoreBoard(
        {
          worktrees,
          agents,
          consoles: { spawn: (o) => ptys.spawn(o, 80, 24) },
          groups,
          squads,
          flow,
          slots,
          canResume: (cwd, sid) => hasTranscript(projects, cwd, sid),
          cancelled,
          stop: async (o, ids) => {
            for (const id of ids) {
              if (agents.has(o, id)) await agents.stop(o, id).catch(() => undefined)
              else await ptys.kill(o, id).catch(() => undefined)
              forgetCard(o, id)
            }
          },
        },
        senderId,
        r,
        saved,
        choice !== 'fresh',
        only,
      )
      if (res.cancelled || cancelled()) return none
      const l = layoutOf(res.board)
      const active = l.active
      for (const id of before) if (known(senderId, id)) l.nodes.push({ id, workspaceId: active, x: 0, y: 0, w: 0, h: 0, pinned: false, collapsed: false })
      const webTiles = reopenTiles(senderId, r.root, new Set(res.board.workspaces.map((w) => w.id)))
      l.nodes.push(...tileLayout(webTiles))
      layout = l // a console's workspace, for the loops that watch one (nothing is saved before attach)
      // loops of agents that came back, paused until the user resumes them; anything that does not validate any more is dropped
      for (const s of remapLoops(savedLoops, res.ids)) {
        try {
          loops.restore(senderId, s)
        } catch {
          // dropped
        }
      }
      // loops of the agents left behind stay saved; one watching a terminal follows it to its new id, or goes with a console that is gone
      const closedIds = new Set(res.pending.agents.map((a) => a.id))
      pendingLoops = savedLoops.flatMap((s) => {
        if (!closedIds.has(s.agentId)) return []
        if (s.trigger.kind !== 'output') return [s]
        const terminalId = res.ids.get(s.trigger.terminalId) ?? (closedIds.has(s.trigger.terminalId) ? s.trigger.terminalId : null)
        return terminalId ? [{ ...s, trigger: { ...s.trigger, terminalId } }] : []
      })
      attach(senderId, r.root, l, res.pending)
      const edges = flow.list(senderId).map(edgeDto)
      const notice = [restoreNotice(res.skipped), droppedNote].filter(Boolean).join(' ') || null
      const drawn = loadAnnotations(r.root, new Set(res.board.workspaces.map((w) => w.id)))
      // nothing came back but something was drawn: the workspaces still come, so the drawings keep their board
      return { board: res.board.nodes.some((n) => n.kind === 'agent' || n.kind === 'console') || drawn.length > 0 || webTiles.length > 0 ? boardView(res, edges) : null, annotations: drawn, webTiles, notice: notice && notice.slice(0, 500) }
    } finally {
      restoring = false
    }
  }
  let autoOpened = false
  /** The renderer's pick of saved terminals to relaunch; nothing picked when the window goes away or reloads meanwhile. */
  const choosers = new Map<number, (ids: string[]) => void>()
  const chooseTerminals = (senderId: number, saved: SavedBoard): Promise<Set<string>> =>
    new Promise((resolve) => {
      const wc = webContents.fromId(senderId)
      if (!wc || wc.isDestroyed()) return resolve(new Set())
      const done = (ids: string[]) => {
        choosers.delete(senderId)
        wc.off('destroyed', none)
        wc.off('did-start-loading', none)
        resolve(new Set(ids))
      }
      const none = () => done([])
      wc.once('destroyed', none)
      wc.once('did-start-loading', none)
      choosers.set(senderId, done)
      const agentOf = new Map(saved.agents.map((a) => [a.id, a]))
      const terminals = saved.nodes.flatMap((n): { id: string; name: string; role: string | null }[] => {
        const a = agentOf.get(n.id)
        if (n.kind === 'agent') return a && !savedAgentProblem(a) ? [{ id: n.id, name: a.name, role: a.role }] : []
        return n.kind === 'console' ? [{ id: n.id, name: 'Console', role: null }] : []
      })
      const free = slots.free()
      // the event carries at most 200: an agent beyond that simply stays saved
      send(senderId, 'board:choose', { terminals: terminals.slice(0, 200), room: Number.isFinite(free) ? Math.max(0, free) : null, agentBytes: Math.round(slots.agentBytes) })
    })
  handle('board:chosen', appOrigin, ({ ids }, { senderId }) => (choosers.get(senderId)?.(ids), { ok: true as const }))
  // once per app run: the last project comes back by itself if it still is a git repository (else the app starts empty, silently)
  handle('board:restore', appOrigin, (_in, { senderId }) =>
    safe('Could not restore the board', async () => {
      const view = () => repo && { name: repo.name.slice(0, 255), branch: repo.branch.slice(0, 255) }
      if (autoOpened || repo || !gitPath || !boards) return { repo: view(), board: null, annotations: [], webTiles: [], notice: null }
      autoOpened = true
      const root = boards.lastProject()
      const next = root ? await worktrees.openRepo(root).catch(() => null) : null
      if (!next) return { repo: null, board: null, annotations: [], webTiles: [], notice: null }
      repo = next
      return { repo: view(), ...(await openBoard(senderId, next)) }
    }),
  )
  handle('board:saveLayout', appOrigin, (input, { senderId }) => {
    if (target?.ownerId === senderId && !restoring) {
      layout = acceptLayout(input, (id) => known(senderId, id))
      persist()
      // a workspace the renderer no longer lists was closed: its annotations (and image files) go
      try {
        if (annotations) {
          const gone = staleWorkspaces(knownWs, layout.workspaces.map((w) => w.id))
          dropImages(annotations.prune(target.root, gone))
          for (const w of gone) knownWs.delete(w)
        }
      } catch {
        // the next layout save tries again
      }
    }
    for (const done of flushWaiters.splice(0)) done()
    return { ok: true as const }
  })
  handle('annotations:save', appOrigin, ({ workspaceId, items }, { senderId }) => {
    // only for the open project, and never while its board is coming back; without a project they live in the renderer only
    if (target?.ownerId === senderId && !restoring && annotations) {
      try {
        // an image id must be one main made for this window or one of the open project's own: anything else is dropped
        const mine = createdImages.get(senderId)
        const owned = annotations.projectImageIds(target.root)
        const ok = items.filter((a) => a.kind !== 'image' || mine?.has(a.imageId.toLowerCase()) || owned.has(a.imageId.toLowerCase()))
        const removed = annotations.replace(target.root, workspaceId, ok)
        knownWs.add(workspaceId)
        dropImages(removed)
      } catch {
        // the next change saves again; nothing about the board is logged
      }
    }
    return { ok: true as const }
  })
  // Test-only: a file to add instead of the file dialog (same validation); ignored in packaged builds.
  const testImage = app.isPackaged ? undefined : process.env['NODSHELL_TEST_IMAGE']
  handle('image:pick', appOrigin, (_in, { senderId }) =>
    safe('Could not add the image', async () => {
      let file = testImage && isAbsolute(testImage) ? testImage : undefined
      if (!file) {
        const win = windowOf(senderId)
        const opts = { title: 'Add image', buttonLabel: 'Add', properties: ['openFile' as const], filters: [{ name: 'Images (PNG, JPEG, WebP, GIF)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] }
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        file = r.canceled ? undefined : r.filePaths[0]
      }
      const image = file ? images.add(readPicked(file)) : null
      if (image) (createdImages.get(senderId) ?? createdImages.set(senderId, new Set()).get(senderId)!).add(image.id)
      return { image }
    }),
  )
  handle('image:paste', appOrigin, (_in, { senderId }) =>
    safe('Could not paste the image', async () => {
      // the clipboard is read here, never in the renderer; the bytes go through the same validation as a picked file
      const hit = (await clipboard.read()).flatMap((item) => item.types.filter((t) => /^image\/(png|jpeg|webp|gif)$/.test(t)).map((t) => ({ item, t })))[0]
      if (!hit) throw new IpcError('No image in the clipboard')
      const blob = await hit.item.getType(hit.t)
      if (!(blob instanceof Blob)) throw new IpcError('No image in the clipboard')
      if (blob.size > IMAGE_MAX_BYTES) throw new ImageError('Image is larger than 5 MB')
      const image = images.add(new Uint8Array(await blob.arrayBuffer()))
      ;(createdImages.get(senderId) ?? createdImages.set(senderId, new Set()).get(senderId)!).add(image.id)
      return { image }
    }),
  )
  // Web tiles: every address is validated here (the renderer only types it); a tile id only works for the window that made it
  handle('webtile:create', appOrigin, ({ address, workspaceId }, { senderId }) =>
    safe('Could not open the page', () => {
      const win = windowOf(senderId)
      if (!win) throw new IpcError('Forbidden')
      const t = tiles.create(senderId, win, workspaceId, normalizeAddress(address))
      return { tile: { id: t.id, workspaceId, title: t.title, address: t.address } }
    }),
  )
  handle('webtile:navigate', appOrigin, ({ id, address }, { senderId }) => safe('Could not open the page', () => (tiles.navigate(senderId, id, normalizeAddress(address)), { ok: true as const })))
  handle('webtile:reload', appOrigin, ({ id }, { senderId }) => safe('Could not reload the page', () => (tiles.reload(senderId, id), { ok: true as const })))
  handle('webtile:back', appOrigin, ({ id }, { senderId }) => safe('Could not go back', () => (tiles.back(senderId, id), { ok: true as const })))
  handle('webtile:forward', appOrigin, ({ id }, { senderId }) => safe('Could not go forward', () => (tiles.forward(senderId, id), { ok: true as const })))
  handle('webtile:close', appOrigin, ({ id }, { senderId }) => safe('Could not close the web tile', () => (tiles.close(senderId, id), { ok: true as const })))
  handle('webtile:place', appOrigin, (p, { senderId }) => safe('Unknown web tile', () => (tiles.place(senderId, p), { ok: true as const })))
  handle('webtile:focus', appOrigin, ({ id }, { senderId }) => safe('Could not focus the page', () => (tiles.focus(senderId, id), { ok: true as const })))
  handle('memory:get', appOrigin, ({ scope }) => safe('Could not read the memory', () => needMemory().read(scope, repo?.root ?? null)))
  handle('memory:save', appOrigin, ({ scope, content }) => safe('Could not save the memory', () => needMemory().write(scope, repo?.root ?? null, content, 'you')))
  handle('workspace:closeTerminals', appOrigin, ({ ids }, { senderId }) =>
    safe('Could not close the workspace', () => closeBatch(senderId, ids, `Close ${ids.length} terminal${ids.length > 1 ? 's' : ''}?`, 'Agents or programs are still running in them and will be stopped. Each agent worktree is then handled as when closing it alone.')),
  )
  handle('workspace:pickRepo', appOrigin, (_in, { senderId }) =>
    safe('Could not open the folder', async () => {
      if (!gitPath) throw new AgentError('git is not installed')
      notRestoring()
      if (repo) assertNotStarting({ starting }) // before the dialog: an agent still starting would end up without a card
      // Test-only: skips the dialog (same validation below); ignored in packaged builds.
      const testRepo = app.isPackaged ? undefined : process.env['NODSHELL_TEST_REPO']
      let dir = testRepo
      if (!dir) {
        const win = windowOf(senderId)
        const opts = { title: 'Open folder', buttonLabel: 'Open', properties: ['openDirectory' as const, 'createDirectory' as const] }
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        dir = r.canceled ? undefined : r.filePaths[0]
      }
      const view = () => repo && { name: repo.name.slice(0, 255), branch: repo.branch.slice(0, 255) }
      const none = { kept: 0, archived: 0, board: null, annotations: [], webTiles: [], notice: null }
      if (!dir) return { repo: view(), changed: false, ...none }
      const next = await worktrees.openRepo(dir)
      if (repo !== null && repo.root === next.root) return { repo: view(), changed: false, ...none }
      const switching = repo !== null
      if (switching) {
        // another project: everything of this window (what main knows, not what the renderer lists) ends first, after a single question; "Keep running" leaves everything as it was
        const r = await endProject({
          starting,
          ownedIds: () => [...new Set([...agents.idsOf(senderId), ...ptys.idsOf(senderId)])],
          closeAll: (ids) => leaveBatch(senderId, ids),
        })
        if (!r.changed) return { repo: view(), changed: false, ...none }
        detach() // when nothing was running, nothing above saved it yet
        tiles.closeOwned(senderId) // saved with the old project; they come back with it
        // nothing of the old project is left to keep paused
        ptys.contOwned(senderId)
        flow.resumeAll(senderId)
        loops.dropOwner(senderId) // its agents are gone; nothing of the old project's loops may keep a timer
        handoffs.dropOwner(senderId)
      }
      repo = next
      const opened = await openBoard(senderId, next)
      return { repo: view(), changed: switching, kept: 0, archived: 0, ...opened }
    }),
  )
  const diagnostics = () =>
    buildDiagnostics({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      consoles: ptys.size,
      agents: agents.size,
      maxProcesses: ptys.limit,
      failures: recentFailures(),
    })
  handle('app:diagnostics', appOrigin, () => ({ version: app.getVersion(), text: diagnostics() }))
  handle('app:copyDiagnostics', appOrigin, () => (clipboard.writeText(diagnostics()), { ok: true as const }))
  handle('preset:list', appOrigin, () => safe('Could not load presets', () => ({ presets: needPresets().list().map(presetDto) })))
  handle('preset:save', appOrigin, (input) => safe('Could not save the preset', () => ({ preset: presetDto(needPresets().save(input)) })))
  handle('preset:delete', appOrigin, ({ id }) => safe('Could not delete the preset', () => (needPresets().delete(id), { ok: true as const })))
  handle('agent:spawnMany', appOrigin, ({ presetId, count, cols, rows, workspaceId }, { senderId }) =>
    safe('Could not start the agents', async () => {
      notRestoring()
      notPaused(senderId)
      const r = await spawnMany({ presets: needPresets(), agents, groups, slots }, senderId, repo, { presetId, count, cols, rows, workspaceId })
      persist()
      return r
    }),
  )
  handle('group:create', appOrigin, ({ name, memberIds }, { senderId }) =>
    safe('Could not create the group', () => {
      const g = groups.create(senderId, name, memberIds)
      persist()
      return { id: g.id, name: g.name }
    }),
  )
  handle('squad:create', appOrigin, ({ cols, rows, workspaceId, perGroup }, { senderId }) =>
    safe('Could not start the squad', async () => {
      notRestoring()
      notPaused(senderId)
      const r = await createSquad({ presets: needPresets(), agents, groups, squads, slots, flow }, senderId, repo, { cols, rows, workspaceId }, perGroup)
      return { ...r, edges: r.edges.map(edgeDto) }
    }),
  )
  handle('squad:connect', appOrigin, ({ id }, { senderId }) =>
    safe('Could not connect the squad', () => {
      const s = squads.get(senderId, id)
      if (!s) throw new AgentError('Unknown squad')
      connectSquad(flow, senderId, s, flow.list(senderId))
      const mine = (e: Edge) => e.target.kind === 'squad' && e.target.id === s.id && e.source.kind === 'group' && s.groupIds.includes(e.source.id)
      return { edges: flow.list(senderId).filter(mine).map(edgeDto) }
    }),
  )
  handle('flow:create', appOrigin, ({ source, target }, { senderId }) => safe('Could not connect', () => ({ edge: edgeDto(flow.create(senderId, source, target)) })))
  handle('flow:update', appOrigin, ({ id, ...patch }, { senderId }) => safe('Could not update the edge', () => ({ edge: edgeDto(flow.update(senderId, id, patch)) })))
  handle('flow:remove', appOrigin, ({ id }, { senderId }) => safe('Could not remove the edge', () => (flow.remove(senderId, id), { ok: true as const })))
  // processes first, so the state the flow engine then reports already says they are stopped
  const pauseAll = (ownerId: number) => (ptys.stopOwned(ownerId), flow.pauseAll(ownerId), loops.restartIdle(ownerId))
  handle('flow:pauseAll', appOrigin, (_in, { senderId }) => (pauseAll(senderId), { ok: true as const }))
  // Memory guard: with the system about to run out (which freezes the whole machine), everything is paused once, so nothing grows
  // further and the user can close terminals. Armed again only after memory recovered: resuming while still low is the user's call.
  let memoryTripped = false
  setInterval(() => {
    const avail = availBytes()
    if (avail === null) return
    if (avail > RESERVE_BYTES + AGENT_BYTES / 2) memoryTripped = false
    if (avail >= RESERVE_BYTES || memoryTripped) return
    const owners = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.webContents.id).filter((o) => ptys.idsOf(o).length > 0 && !ptys.isStopped(o))
    if (owners.length === 0) return
    memoryTripped = true
    for (const o of owners) {
      pauseAll(o)
      send(o, 'loop:notice', { text: `Memory is almost full (${(avail / 2 ** 30).toFixed(1)} GB free), everything was paused. Close some terminals, then Resume all` })
    }
  }, 2000).unref()
  handle('flow:resumeAll', appOrigin, (_in, { senderId }) => (ptys.contOwned(senderId), flow.resumeAll(senderId), loops.restartIdle(senderId), { ok: true as const }))
  // loops: the agent and a watched terminal must be of the calling window and of one workspace (checked in LoopEngine.set)
  handle('loop:list', appOrigin, (_in, { senderId }) => ({ loops: loops.list(senderId).map(loopDto) }))
  handle('loop:set', appOrigin, ({ agentId, ...input }, { senderId }) => safe('Could not save the loop', () => ({ loop: loopDto(loops.set(senderId, agentId, input)) })))
  handle('loop:update', appOrigin, ({ id, paused }, { senderId }) => safe('Could not update the loop', () => ({ loop: loopDto(loops.update(senderId, id, paused)) })))
  handle('loop:remove', appOrigin, ({ id }, { senderId }) => safe('Could not remove the loop', () => (loops.remove(senderId, id), { ok: true as const })))
  // handoffs: both agents of the calling window and of one workspace, the outgoing one resting (checked in HandoffService)
  handle('handoff:start', appOrigin, ({ fromId, toId }, { senderId }) => safe('Could not start the handoff', async () => ({ handoff: handoffDto(await handoffs.start(senderId, fromId, toId)) })))
  handle('handoff:send', appOrigin, ({ id, text }, { senderId }) => safe('Could not send the handoff', async () => ({ result: await handoffs.send(senderId, id, text) })))
  handle('handoff:cancel', appOrigin, ({ id }, { senderId }) => safe('Could not cancel the handoff', () => (handoffs.cancel(senderId, id), { ok: true as const })))
  handle('group:dissolve', appOrigin, ({ id }, { senderId }) => safe('Could not ungroup', () => (groups.dissolve(senderId, id), flow.prune(senderId), persist(), { ok: true as const })))
  handle('agent:prompt', appOrigin, ({ id, text }, { senderId }) =>
    safe('Could not send the prompt', async () => {
      notPaused(senderId)
      if (agents.has(senderId, id)) {
        flow.userPrompt(id) // the user's prompt starts a new chain
        spawner.userPrompted(id)
      }
      await agents.submitPrompt(senderId, id, text, () => (ptys.isStopped(senderId) ? PAUSED_MESSAGE : null))
      return { ok: true as const }
    }),
  )
  // typed or dictated command: the same delivery path and rules as the manual prompt; the renderer never picks the target
  const commandView = {
    state: (o: number) => ({ agents: agents.list(o).map(({ id, name, role, workspaceId: w, state, statusUnavailable }) => ({ id, name, role, workspaceId: w, state, statusUnavailable })), groups: groups.list(o), squads: squads.list(o) }),
    paused: (o: number) => ptys.isStopped(o),
  }
  // advisory and side-effect free: the same plan as command:send, nothing is submitted
  handle('command:preview', appOrigin, ({ text, workspaceId, squadId }, { senderId }) => safe('Could not preview the command', () => previewCommand(commandView, senderId, { workspaceId, squadId }, text)))
  handle('command:send', appOrigin, ({ text, workspaceId, squadId }, { senderId }) =>
    safe('Could not send the command', () =>
      sendCommand(
        {
          ...commandView,
          submit: async (o, id, t) => {
            flow.userPrompt(id) // the user's prompt starts a new chain
            spawner.userPrompted(id)
            await agents.submitPrompt(o, id, t, () => (ptys.isStopped(o) ? PAUSED_MESSAGE : null))
          },
        },
        senderId,
        { workspaceId, squadId },
        text,
      ),
    ),
  )
  const stt = whisperFromEnv()
  app.on('will-quit', () => stt.abort())
  handle('voice:status', appOrigin, () => ({ available: stt.available() }))
  // the audio lives only in memory (IPC buffer, then the child's stdin); neither it nor the text is ever logged
  handle('voice:transcribe', appOrigin, ({ pcm }, { senderId }) => safe('Could not transcribe', async () => {
      sttOwner = senderId
      try {
        return { text: await stt.transcribe(pcm, { names: [...agents.list(senderId).map((a) => a.name), ...groups.list(senderId).map((g) => g.name)] }) }
      } finally {
        sttOwner = null
      }
    }),
  )
  handle('agent:lastMessage', appOrigin, ({ id }, { senderId }) =>
    safe('Could not read the last message', () => agents.lastMessage(senderId, id)),
  )
  handle('agent:close', appOrigin, ({ id }, { senderId }) =>
    safe('Could not close the agent', async () => {
      const worktree: RemovalOutcome | 'cancelled' | 'stopped' = await closeAgent({
        has: () => agents.has(senderId, id),
        close: () => agents.close(senderId, id, confirmFor(senderId), (a) => confirmClose(senderId, `Stop ${a.name}?`, `${a.name} (${a.role}) is still running. Closing stops it; its worktree is then handled as before.`)),
        forget: () => forgetCard(senderId, id),
      })
      return { worktree: worktree === 'stopped' ? ('kept' as const) : worktree } // never stopped here: no keepWorktree on this path
    }),
  )
  // memory of the app (all its Electron processes) plus every terminal's process tree, shown next to the live count
  const firstSeen = new Map<string, number>() // terminal id -> when reportMemory first saw it
  const reportMemory = () => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (wins.length === 0) return
    const app_ = Math.round(app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0) * 1024)
    const rss = sessionRssBy(ptys.pids())
    const total = totalBytes()
    const avail = availBytes()
    const system = total !== null && avail !== null ? { total, available: Math.round(avail) } : null
    const t = Date.now()
    const live = new Set<string>()
    const measured: { bytes: number; ageMs: number }[] = []
    for (const w of wins) {
      const o = w.webContents.id
      const terminals = ptys.leaders(o).map((l) => ({ id: l.id, bytes: rss.get(l.pid) ?? 0 }))
      for (const x of terminals) {
        live.add(x.id)
        if (!firstSeen.has(x.id)) firstSeen.set(x.id, t)
        if (agents.has(o, x.id)) measured.push({ bytes: x.bytes, ageMs: t - (firstSeen.get(x.id) ?? t) })
      }
      const bytes = app_ + terminals.reduce((n, t) => n + t.bytes, 0)
      send(w.webContents.id, 'app:memory', { bytes, app: app_, terminals, system })
    }
    for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id)
    perAgentBytes = agentCost(measured)
  }
  setTimeout(reportMemory, 1500).unref()
  setInterval(reportMemory, 5000).unref()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
