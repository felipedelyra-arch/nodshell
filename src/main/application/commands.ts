import { AgentError } from '../domain/agent'
import type { AgentState } from '../domain/adapter'

export type CommandAgent = { id: string; name: string; role: string; workspaceId?: string; state: AgentState; statusUnavailable: boolean }
export type CommandGroup = { id: string; name: string; memberIds: string[] }
export type CommandSquad = { id: string; orchestratorId: string; groupIds: string[]; extraIds: string[] }
export type CommandState = { agents: CommandAgent[]; groups: CommandGroup[]; squads: CommandSquad[] }
export type CommandScope = { workspaceId: string; squadId?: string }
export type Target = { id: string; name: string }
export type Refusal = { name: string; reason: string }
export type Route = { targets: Target[]; text: string; refused: Refusal[] }

const NAMES_SHOWN = 8
const NO_ORCHESTRATOR = 'No Orchestrator in this workspace; start the message with @name to reach an agent or group'

/**
 * Who a typed or dictated command goes to. Pure: the renderer sends only text and scope, the state is the main's own.
 * `@name` (no case, longest name that fits, then a space or the end) is an agent's short name or a group's name inside the scope and is
 * stripped from the text; without it the command goes to the Orchestrator(s) of the scope. Problems come back as `refused`, never thrown.
 */
export function routeCommand(input: string, scope: CommandScope, st: CommandState): Route {
  const text = input.trim()
  const inWs = st.agents.filter((a) => a.workspaceId === scope.workspaceId)
  const byId = new Map(inWs.map((a) => [a.id, a]))
  const squad = scope.squadId === undefined ? undefined : st.squads.find((s) => s.id === scope.squadId)
  if (scope.squadId !== undefined && (!squad || !byId.has(squad.orchestratorId))) return { targets: [], text, refused: [{ name: 'Orchestrator', reason: 'This squad is gone' }] }
  const squadOf = (s: CommandSquad) => byId.get(s.orchestratorId)
  const orchestrators = (squad ? [squad] : st.squads).flatMap((s) => squadOf(s) ?? [])

  if (!text.startsWith('@')) {
    return orchestrators.length === 0 ? { targets: [], text, refused: [{ name: 'Orchestrator', reason: NO_ORCHESTRATOR }] } : { targets: orchestrators.map(({ id, name }) => ({ id, name })), text, refused: [] }
  }

  // candidates: in a squad, only its agents (its Orchestrator included) and groups; else the whole workspace
  const ids = squad ? new Set([squad.orchestratorId, ...squad.extraIds, ...st.groups.filter((g) => squad.groupIds.includes(g.id)).flatMap((g) => g.memberIds)]) : null
  const agents = inWs.filter((a) => !ids || ids.has(a.id))
  const groups = st.groups.filter((g) => (squad ? squad.groupIds.includes(g.id) : true) && g.memberIds.some((m) => byId.has(m)))
  const rest = text.slice(1)
  const lower = rest.toLowerCase()
  const fits = (n: string) => lower.startsWith(n.toLowerCase()) && (rest.length === n.length || /\s/.test(rest.charAt(n.length)))
  const names = [...new Set([...agents.map((a) => a.name), ...groups.map((g) => g.name)])]
  const best = names.filter(fits).sort((a, b) => b.length - a.length)[0]
  if (best === undefined) {
    const word = (rest.split(/\s/, 1)[0] ?? '').slice(0, 30)
    const shown = names.slice(0, NAMES_SHOWN).join(', ')
    const more = names.length > NAMES_SHOWN ? ', ...' : ''
    return { targets: [], text, refused: [{ name: `@${word}`, reason: names.length ? `No agent or group with that name. Try: ${shown}${more}` : 'There are no agents or groups here yet' }] }
  }
  const body = rest.slice(best.length).trim()
  if (!body) return { targets: [], text: body, refused: [{ name: `@${best}`, reason: 'Nothing to send after the name' }] }
  const agent = agents.find((a) => a.name.toLowerCase() === best.toLowerCase())
  const members = agent ? [agent] : groups.filter((g) => g.name.toLowerCase() === best.toLowerCase()).flatMap((g) => g.memberIds.flatMap((m) => byId.get(m) ?? []))
  const targets = [...new Map(members.map((a) => [a.id, { id: a.id, name: a.name }])).values()]
  return { targets, text: body, refused: [] }
}

/** Why a command cannot be typed into this agent now (the manual prompt's rules, but stricter while starting), or null. */
export function promptRefusal(a: Pick<CommandAgent, 'state'>): string | null {
  if (a.state === 'exited' || a.state === 'error') return 'is not running'
  // always, even with live status unavailable: the target may be a group or every Orchestrator, unseen, and its Enter could answer the trust dialog
  if (a.state === 'starting') return 'is still starting'
  if (a.state === 'waiting') return 'needs you: answer in its terminal first'
  return null
}

export type CommandDeps = {
  state(ownerId: number): CommandState
  paused(ownerId: number): boolean
  /** The same path as the manual prompt: marks it as the user's own, then types it in (guards inside). */
  submit(ownerId: number, id: string, text: string): Promise<void>
}

/** SendCommand: route, then deliver each target separately; one refusal never stops the others. */
export async function sendCommand(d: CommandDeps, ownerId: number, scope: CommandScope, text: string): Promise<{ delivered: string[]; refused: Refusal[] }> {
  const st = d.state(ownerId)
  const route = routeCommand(text, scope, st)
  const refused = [...route.refused]
  const delivered: string[] = []
  const paused = d.paused(ownerId)
  await Promise.all(
    route.targets.map(async (t) => {
      const a = st.agents.find((x) => x.id === t.id)
      const why = paused ? 'is paused' : a ? promptRefusal(a) : 'is not running'
      if (why) return void refused.push({ name: t.name, reason: why })
      try {
        await d.submit(ownerId, t.id, route.text)
        delivered.push(t.name)
      } catch (e) {
        refused.push({ name: t.name, reason: e instanceof AgentError ? e.message : 'could not be reached' })
      }
    }),
  )
  // bounded: these strings reach a toast (and the IPC schema)
  return { delivered: route.targets.map((t) => t.name).filter((n) => delivered.includes(n)), refused: refused.map((r) => ({ name: r.name.slice(0, 60), reason: r.reason.slice(0, 300) })) }
}
