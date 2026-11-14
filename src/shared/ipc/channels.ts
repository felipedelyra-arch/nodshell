import { z } from 'zod'
import { imageInfo, workspaceAnnotations } from '../annotation'
import { AGENT_NAME_RE, AGENT_STATES, LAST_MESSAGE_MAX, LIVE_HARD_MAX, LIVE_LIMIT_MIN, MODEL_CHOICES, PROMPT_MAX, ROLE_RE, SQUAD_GROUP_SIZE, SQUAD_ROLES, SQUAD_SIZE, WORKSPACES_MAX } from '../agent'
import { MEMORY_EDITOR_RE, MEMORY_MAX, MEMORY_SCOPES } from '../memory'
import { CONDITION_MAX, EDGES_MAX, REASON_MAX, REPORT_MAX, TASK_STATUSES, TASK_TITLE_MAX, TASKS_MAX, TASKS_RECENT, TEMPLATE_MAX } from '../flow'
import { CONTROL_RE, GROUP_NAME_MAX, PRESET_NAME_MAX } from '../preset'
import { PCM_MAX_BYTES } from '../voice'
import { ADDRESS_MAX, ADDRESS_SHOWN_MAX, TITLE_MAX, WEBTILES_MAX } from '../webtile'
import { GOAL_MAX, IDLE_MAX_SEC, IDLE_MIN_SEC, LOOP_RUNS_MAX, LOOP_STATES, OUTPUT_TEXT_MAX, SCHEDULE_MAX_SEC, SCHEDULE_MIN_SEC } from '../loop'
import { BRIEFING_MAX, HANDOFF_STATES } from '../handoff'
import { channelNames, eventNames } from './names'

const id = z.uuid()
const cols = z.number().int().min(2).max(500)
const rows = z.number().int().min(1).max(300)
const ok = z.object({ ok: z.literal(true) })
const label = z.string().min(1).max(255)
const state = z.enum(AGENT_STATES)
const agentInfo = z.object({ id, name: z.string().regex(AGENT_NAME_RE), role: z.string().regex(ROLE_RE), branch: z.string().max(50), model: z.string().max(64), state, statusUnavailable: z.boolean() })
const MAX_CARDS = LIVE_HARD_MAX // the PTY limit is configurable up to this ceiling
// live processes are capped at LIVE_HARD_MAX, but an exited agent keeps its card until closed, so a workspace can hold far more ids than that
const MAX_BOARD_IDS = 200
const left = { kept: z.number().int().min(0).max(MAX_BOARD_IDS), archived: z.number().int().min(0).max(MAX_BOARD_IDS) }
const presetOut = z.object({
  id,
  name: z.string().min(1).max(PRESET_NAME_MAX),
  role: z.string().regex(ROLE_RE),
  adapter: z.enum(['claude', 'generic']),
  model: z.enum(MODEL_CHOICES).nullable(),
  systemPrompt: z.string().max(PROMPT_MAX),
  builtin: z.boolean(),
})
const groupName = z.string().trim().min(1).max(GROUP_NAME_MAX).refine((n) => !CONTROL_RE.test(n))
// flows: an edge between two ends of one workspace; ids only, never a name, path or command
const source = z.object({ kind: z.enum(['agent', 'group']), id })
const target = z.object({ kind: z.enum(['agent', 'group', 'squad']), id })
const template = z.string().min(1).max(TEMPLATE_MAX).refine((t) => !t.includes('\0') && t.trim().length > 0)
const condition = z.string().max(CONDITION_MAX).refine((c) => !CONTROL_RE.test(c))
const reason = z.string().max(REASON_MAX)
const edgeOut = z.object({ id, workspaceId: id, source, target, template, condition, paused: reason.nullable(), note: reason.nullable() })
// memory: text only; who edited it last is "you" or an agent's short name
const scope = z.enum(MEMORY_SCOPES)
const memoryOut = z.object({ content: z.string().max(MEMORY_MAX), updatedAt: z.number().int().nullable(), updatedBy: z.string().regex(MEMORY_EDITOR_RE).nullable() })
// board layout: ids, places and sizes only, never a path; every number is bounded
const coord = z.number().finite().min(-1_000_000).max(1_000_000)
const size = z.number().finite().min(0).max(100_000)
const viewport = z.object({ x: coord, y: coord, zoom: z.number().finite().min(0.05).max(4) })
const workspaceOut = z.object({ id, name: groupName, viewport })
// a saved board coming back: terminals (relaunched, with new ids), groups, squads and edges around them
const boardOut = z.object({
  workspaces: z.array(workspaceOut).min(1).max(WORKSPACES_MAX),
  active: id,
  terminals: z.array(z.object({ id, workspaceId: id, x: coord, y: coord, w: size, h: size, pinned: z.boolean(), name: z.string().max(50), agent: agentInfo.nullable() })).max(LIVE_HARD_MAX),
  groups: z.array(z.object({ id, name: groupName, workspaceId: id, x: coord, y: coord, collapsed: z.boolean(), memberIds: z.array(id).min(1).max(LIVE_HARD_MAX) })).max(LIVE_HARD_MAX),
  squads: z.array(z.object({ id, workspaceId: id, x: coord, y: coord, orchestratorId: id, groups: z.array(z.object({ id, role: z.string().regex(ROLE_RE) })).max(LIVE_HARD_MAX) })).max(LIVE_HARD_MAX),
  edges: z.array(edgeOut).max(EDGES_MAX),
})
// web tiles: the renderer types an address (main validates it) and gets back only a cleaned title and origin + path, never the page
const address = z.string().min(1).max(ADDRESS_MAX)
const tileText = { title: z.string().max(TITLE_MAX).refine((t) => !CONTROL_RE.test(t)), address: z.string().max(ADDRESS_SHOWN_MAX).refine((t) => !CONTROL_RE.test(t)) }
const tileOut = z.object({ id, workspaceId: id, ...tileText })
// a restored board, if any, and one line on what did not come back
// annotations and web tiles come back with it, by workspace (also when the board has no terminals but something was drawn or a tile was open)
// loops: one prompt repeated in one agent; main cleans every text (no control or format characters) and checks every id
// eslint-disable-next-line no-control-regex -- a prompt may keep line breaks and tabs, nothing else
const PROMPT_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
const line = (max: number) => z.string().max(max).refine((t) => !CONTROL_RE.test(t))
const trigger = (text: z.ZodType<string>) =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('schedule'), everySec: z.number().int().min(SCHEDULE_MIN_SEC).max(SCHEDULE_MAX_SEC) }),
    z.object({ kind: z.literal('idle'), afterSec: z.number().int().min(IDLE_MIN_SEC).max(IDLE_MAX_SEC) }),
    z.object({ kind: z.literal('output'), terminalId: id, text }),
  ])
const maxRuns = z.number().int().min(1).max(LOOP_RUNS_MAX)
const loopOut = z.object({
  id,
  workspaceId: id,
  agentId: id,
  prompt: z.string().min(1).max(PROMPT_MAX).refine((t) => !PROMPT_CONTROL_RE.test(t)),
  trigger: trigger(line(OUTPUT_TEXT_MAX).min(1)),
  goal: line(GOAL_MAX),
  maxRuns,
  runs: z.number().int().min(0).max(LOOP_RUNS_MAX),
  state: z.enum(LOOP_STATES),
  reason: reason.nullable(),
})
// handoffs: ids and state; the briefing (cleaned in main) only ever goes to the window that owns the handoff
const handoffOut = z.object({ id, workspaceId: id, fromId: id, toId: id, state: z.enum(HANDOFF_STATES), briefing: z.string().max(BRIEFING_MAX).refine((t) => !PROMPT_CONTROL_RE.test(t)) })
const restored = {
  board: boardOut.nullable(),
  annotations: z.array(workspaceAnnotations).max(WORKSPACES_MAX),
  webTiles: z.array(tileOut.extend({ x: coord, y: coord, w: size, h: size })).max(WEBTILES_MAX),
  notice: z.string().max(500).nullable(),
}

export const channels = {
  ping: {
    in: z.object({ message: z.string().min(1).max(100) }),
    out: z.object({ reply: z.string(), at: z.number().int() }),
  },
  'pty:spawn': { in: z.object({ cols, rows }), out: z.object({ id, name: z.string().max(50) }) },
  'pty:write': { in: z.object({ id, data: z.string().max(65536) }), out: ok },
  'pty:resize': { in: z.object({ id, cols, rows }), out: ok },
  // closed=false: the user kept a terminal that still runs a program
  'pty:kill': { in: z.object({ id }), out: z.object({ closed: z.boolean() }) },
  'pty:ack': { in: z.object({ id, bytes: z.number().int().min(1).max(100_000_000) }), out: ok },
  // the renderer never sends a path: main shows the folder dialog and returns only display data
  // the renderer sends nothing: main closes everything of the window itself, after one question, and only then switches repository
  // changed=false: cancelled, same repository, or the user kept the running terminals; kept/archived: what the closed agents left behind
  'workspace:pickRepo': {
    in: z.undefined(),
    out: z.object({ repo: z.object({ name: label, branch: label }).nullable(), changed: z.boolean(), ...left, ...restored }),
  },
  // at startup: main reopens the last project (if still a git repository) and, after one question, its saved board
  'board:restore': { in: z.undefined(), out: z.object({ repo: z.object({ name: label, branch: label }).nullable(), ...restored }) },
  // the renderer's part of the board (main knows the rest); ids main does not know for this window are ignored
  'board:saveLayout': {
    in: z.object({
      workspaces: z.array(workspaceOut).min(1).max(WORKSPACES_MAX),
      active: id,
      nodes: z.array(z.object({ id, workspaceId: id, x: coord, y: coord, w: size, h: size, pinned: z.boolean(), collapsed: z.boolean() })).max(2 * MAX_BOARD_IDS),
    }),
    out: ok,
  },
  // annotations of one workspace (the whole list; main replaces what it had); only for the open project
  'annotations:save': { in: workspaceAnnotations, out: ok },
  // image files: main opens the file dialog or reads the clipboard, validates and stores the bytes; the renderer only gets an id and the size
  // (null: the dialog was cancelled). The renderer never sends or receives a path.
  'image:pick': { in: z.undefined(), out: z.object({ image: imageInfo.nullable() }) },
  'image:paste': { in: z.undefined(), out: z.object({ image: imageInfo }) },
  // a web tile in a workspace of this window; refused past WEBTILES_MAX or for any address that is not http or https
  'webtile:create': { in: z.object({ address, workspaceId: id }), out: z.object({ tile: tileOut }) },
  'webtile:navigate': { in: z.object({ id, address }), out: ok },
  'webtile:reload': { in: z.object({ id }), out: ok },
  'webtile:close': { in: z.object({ id }), out: ok },
  // high frequency (at most one per frame and tile): the tile's body in window pixels, the board zoom, and whether it may show
  'webtile:place': {
    in: z.object({ id, x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000), width: z.number().finite().min(0).max(20_000), height: z.number().finite().min(0).max(20_000), zoom: z.number().finite().min(0.05).max(4), visible: z.boolean() }),
    out: ok,
  },
  // the keyboard way into the page (F6 in the page comes back)
  'webtile:focus': { in: z.object({ id }), out: ok },
  'memory:get': { in: z.object({ scope }), out: memoryOut },
  'memory:save': { in: z.object({ scope, content: z.string().max(MEMORY_MAX) }), out: memoryOut },
  // one confirmation for the whole batch; closed=false: the user kept them running
  'workspace:closeTerminals': { in: z.object({ ids: z.array(id).min(1).max(MAX_BOARD_IDS) }), out: z.object({ closed: z.boolean(), ...left }) },
  'preset:list': { in: z.undefined(), out: z.object({ presets: z.array(presetOut) }) },
  'preset:save': {
    in: z.object({
      id: id.optional(), // absent = create
      name: z.string().trim().min(1).max(PRESET_NAME_MAX).refine((n) => !CONTROL_RE.test(n)),
      role: z.string().regex(ROLE_RE),
      model: z.enum(MODEL_CHOICES).nullable(),
      systemPrompt: z.string().max(PROMPT_MAX),
    }),
    out: z.object({ preset: presetOut }),
  },
  'preset:delete': { in: z.object({ id }), out: ok },
  'agent:spawnMany': {
    // workspaceId: the renderer's own key for the board; the group of a preset is per workspace
    in: z.object({ presetId: id, count: z.number().int().min(1).max(MAX_CARDS), cols, rows, workspaceId: id }),
    out: z.object({ agents: z.array(agentInfo), group: z.object({ id, name: groupName, memberIds: z.array(id).max(MAX_CARDS) }), failed: z.number().int().min(0).max(MAX_CARDS) }),
  },
  'group:create': {
    in: z.object({ name: groupName, memberIds: z.array(id).min(1).max(MAX_CARDS) }),
    out: z.object({ id, name: groupName }),
  },
  'group:dissolve': { in: z.object({ id }), out: ok },
  // a squad from the built-in presets: the renderer sends only the terminal size, never a role, path or command
  'squad:create': {
    in: z.object({ cols, rows, workspaceId: id }),
    out: z.object({
      squad: z.object({ id, orchestratorId: id, groupIds: z.array(id).max(SQUAD_ROLES.length) }),
      orchestrator: agentInfo,
      groups: z.array(z.object({ id, name: groupName, role: z.enum(SQUAD_ROLES), memberIds: z.array(id).min(1).max(SQUAD_GROUP_SIZE) })).max(SQUAD_ROLES.length),
      agents: z.array(agentInfo).max(SQUAD_SIZE - 1),
      edges: z.array(edgeOut).max(SQUAD_ROLES.length),
      failed: z.number().int().min(0).max(SQUAD_SIZE - 1),
    }),
  },
  // re-creates the squad's missing group -> Orchestrator edges; returns all of them (to highlight)
  'squad:connect': { in: z.object({ id }), out: z.object({ edges: z.array(edgeOut).max(SQUAD_ROLES.length) }) },
  'flow:create': { in: z.object({ source, target }), out: z.object({ edge: edgeOut }) },
  // paused=false resumes an edge paused by the user or by a guard
  'flow:update': { in: z.object({ id, template: template.optional(), condition: condition.optional(), paused: z.boolean().optional() }), out: z.object({ edge: edgeOut }) },
  'flow:remove': { in: z.object({ id }), out: ok },
  // Pause all: every flow and every process of the window (SIGSTOP); Resume all undoes both
  'flow:pauseAll': { in: z.undefined(), out: ok },
  'flow:resumeAll': { in: z.undefined(), out: ok },
  // diagnostics text built in main from non-sensitive fields only; copying is done in main too (the renderer is sandboxed)
  'app:diagnostics': { in: z.undefined(), out: z.object({ version: z.string().max(32), text: z.string().max(2000) }) },
  'app:copyDiagnostics': { in: z.undefined(), out: ok },
  // the live-terminal limit (1 to the ceiling); lowering it kills nothing, it only stops new terminals
  'settings:get': { in: z.undefined(), out: z.object({ liveLimit: z.number().int().min(LIVE_LIMIT_MIN).max(LIVE_HARD_MAX) }) },
  'settings:setLiveLimit': { in: z.object({ limit: z.number().int().min(LIVE_LIMIT_MIN).max(LIVE_HARD_MAX) }), out: z.object({ liveLimit: z.number().int().min(LIVE_LIMIT_MIN).max(LIVE_HARD_MAX) }) },
  'agent:prompt': { in: z.object({ id, text: z.string().min(1).max(PROMPT_MAX) }), out: ok },
  // a typed or dictated command: only text and scope (workspace, optionally one squad); main decides who gets it
  'command:send': {
    in: z.object({ text: z.string().min(1).max(PROMPT_MAX), workspaceId: id, squadId: id.optional() }),
    out: z.object({ delivered: z.array(z.string().max(60)).max(MAX_BOARD_IDS), refused: z.array(z.object({ name: z.string().max(60), reason: z.string().max(300) })).max(MAX_BOARD_IDS + 2) }),
  },
  'voice:status': { in: z.undefined(), out: z.object({ available: z.boolean() }) },
  // 16 kHz mono 16-bit PCM, at most 60 s, in memory only
  'voice:transcribe': { in: z.object({ pcm: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= PCM_MAX_BYTES && b.byteLength % 2 === 0) }), out: z.object({ text: z.string().max(PROMPT_MAX) }) },
  'loop:list': { in: z.undefined(), out: z.object({ loops: z.array(loopOut).max(MAX_BOARD_IDS) }) },
  // creates or replaces the agent's loop (active, from zero runs); a watched terminal must be of the same window and workspace
  'loop:set': {
    in: z.object({ agentId: id, prompt: z.string().min(1).max(PROMPT_MAX), trigger: trigger(z.string().min(1).max(OUTPUT_TEXT_MAX)), goal: z.string().max(GOAL_MAX), maxRuns }),
    out: z.object({ loop: loopOut }),
  },
  // paused=false resumes a loop paused by the user, by its maxRuns or on reopen, or a done one (from zero runs)
  'loop:update': { in: z.object({ id, paused: z.boolean() }), out: z.object({ loop: loopOut }) },
  'loop:remove': { in: z.object({ id }), out: ok },
  // asks the resting agent fromId for its briefing, for toId in the same workspace (main checks both, and one handoff per agent)
  'handoff:start': { in: z.object({ fromId: id, toId: id }), out: z.object({ handoff: handoffOut }) },
  // only now something reaches toId: one prompt (header + the edited briefing); refused (and kept) when it cannot be delivered
  // the text may exceed BRIEFING_MAX here so main can say so clearly
  'handoff:send': { in: z.object({ id, text: z.string().min(1).max(PROMPT_MAX) }), out: z.object({ result: z.string().max(200) }) },
  'handoff:cancel': { in: z.object({ id }), out: ok },
  'agent:close': { in: z.object({ id }), out: z.object({ worktree: z.enum(['removed', 'archived', 'kept', 'cancelled']) }) },
  'agent:lastMessage': {
    in: z.object({ id }),
    out: z.object({ text: z.string().max(LAST_MESSAGE_MAX).nullable(), source: z.enum(['transcript', 'scrape', 'none']) }),
  },
} as const

/** Main -> renderer events; validated in main before sending. */
export const events = {
  'pty:data': z.object({ id, data: z.string() }),
  // memory of the app and every terminal process, in bytes, every few seconds
  'app:memory': z.object({ bytes: z.number().int().min(0) }),
  'pty:exit': z.object({ id, code: z.number().int() }),
  'agent:state': z.object({ id, state, statusUnavailable: z.boolean(), at: z.number().int() }),
  // the whole flow state of the window after any change: edges, processes stopped, flows paused
  'flow:changed': z.object({ edges: z.array(edgeOut).max(EDGES_MAX), paused: z.boolean(), flowsPaused: z.boolean() }),
  // an edge injected a message (the renderer animates it)
  'flow:fired': z.object({ id }),
  // a guard paused an edge (id) or every flow (id null); the reason is shown to the user
  'flow:paused': z.object({ id: id.nullable(), reason }),
  // report_status from the agent itself; already bounded and stripped of control characters in main
  'agent:report': z.object({ id, text: z.string().max(REPORT_MAX) }),
  // a squad's tasks after any change: counts and the latest titles (first line only, never the message)
  'tasks:changed': z.object({
    squadId: id,
    done: z.number().int().min(0).max(TASKS_MAX),
    total: z.number().int().min(0).max(TASKS_MAX),
    recent: z.array(z.object({ title: z.string().min(1).max(TASK_TITLE_MAX).refine((t) => !CONTROL_RE.test(t)), assignee: groupName, status: z.enum(TASK_STATUSES) })).max(TASKS_RECENT),
  }),
  // an Orchestrator's spawn_agent started an agent: its card joins the squad group of its role (squadId null: the squad went away meanwhile)
  'squad:spawned': z.object({ squadId: id.nullable(), group: z.object({ id, name: groupName, role: z.string().regex(ROLE_RE), created: z.boolean() }).nullable(), agent: agentInfo, workspaceId: id.optional() }),
  // an agent wrote a memory (never its text: the dialog reads it again if the user wants)
  'memory:changed': z.object({ scope, updatedAt: z.number().int(), updatedBy: z.string().regex(MEMORY_EDITOR_RE) }),
  // main is about to save the board for good (quit, close): the renderer sends its layout now
  'board:flush': z.object({}),
  // every loop of the window after any change
  'loop:changed': z.object({ loops: z.array(loopOut).max(MAX_BOARD_IDS) }),
  // a loop ended or paused by itself (goal reached, max runs, watched terminal closed); shown to the user
  'loop:notice': z.object({ text: line(REASON_MAX + 100) }),
  // every handoff of the window after any change; notice: why one ended by itself (shown to the user)
  'handoff:changed': z.object({ handoffs: z.array(handoffOut).max(LIVE_HARD_MAX), notice: line(REASON_MAX + 100).nullable() }),
  // a tile's title, address (origin + path), loading state and error (generic)
  'webtile:changed': z.object({ id, ...tileText, loading: z.boolean(), error: z.string().max(100).nullable() }),
  // F6 in the page: the focus is back in the app, on this tile
  'webtile:returned': z.object({ id }),
} as const

export type ChannelName = keyof typeof channels
export type EventName = keyof typeof events
// compile-time checks that names.ts and the maps agree
export const _namesMatch: readonly ChannelName[] = channelNames satisfies readonly ChannelName[]
export const _mapMatches: Record<(typeof channelNames)[number], unknown> = channels
export const _eventNamesMatch: readonly EventName[] = eventNames satisfies readonly EventName[]
export const _eventMapMatches: Record<(typeof eventNames)[number], unknown> = events
export type ChannelInput<C extends ChannelName> = z.infer<(typeof channels)[C]['in']>
export type ChannelOutput<C extends ChannelName> = z.infer<(typeof channels)[C]['out']>
export type EventPayload<E extends EventName> = z.infer<(typeof events)[E]>
