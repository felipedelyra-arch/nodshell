// Pure board persistence model: what is saved per project (repository root). No Electron, no fs, no SQL.
import type { SourceEndpoint, TargetEndpoint } from './edge'

export type Viewport = { x: number; y: number; zoom: number }
export type SavedWorkspace = { id: string; name: string; order: number; viewport: Viewport; active: boolean }
export const NODE_KINDS = ['console', 'agent', 'group', 'orchestrator'] as const
export type NodeKind = (typeof NODE_KINDS)[number]
/** Layout and membership: `parentId` is the group of a card (or the squad of an Orchestrator's own card), `order` its place there. */
export type SavedNode = { id: string; kind: NodeKind; workspaceId: string; x: number; y: number; w: number; h: number; pinned: boolean; parentId: string | null; order: number }
/** `pending`: it did not come back at the last start (worktree not valid, no free terminal, spawn failed); tried again at the next one. */
export type SavedAgent = { id: string; role: string; presetId: string | null; model: string | null; name: string; systemPrompt: string; branch: string; worktree: string; base: string; sessionId: string; pending: boolean }
export type SavedGroup = { id: string; name: string; collapsed: boolean; presetId: string | null }
export type SavedSquad = { id: string; orchestratorId: string; groupIds: string[]; extraIds: string[] }
export type SavedEdge = { id: string; workspaceId: string; source: SourceEndpoint; target: TargetEndpoint; template: string; condition: string; paused: string | null }
/** Never tasks, delivery queues, command history, tokens nor terminal content. */
export type SavedBoard = { workspaces: SavedWorkspace[]; nodes: SavedNode[]; agents: SavedAgent[]; groups: SavedGroup[]; squads: SavedSquad[]; edges: SavedEdge[] }

export const emptyBoard = (): SavedBoard => ({ workspaces: [], nodes: [], agents: [], groups: [], squads: [], edges: [] })

/** A board worth asking about: at least one terminal (console or agent). */
export const hasTerminals = (b: SavedBoard | null): b is SavedBoard => !!b && b.nodes.some((n) => n.kind === 'console' || n.kind === 'agent')

export type RestoreChoice = 'resume' | 'fresh' | 'empty'
