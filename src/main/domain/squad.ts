// Pure domain: no Electron, no processes.
export { SQUAD_GROUP_SIZE, SQUAD_ROLES, SQUAD_SIZE, type SquadRole } from '../../shared/agent'

/** One Orchestrator agent leading its groups (Frontend, Backend, Testers, Reviewers). The groups outlive the squad. */
/** `extraIds`: live agents the Orchestrator added with spawn_agent (at most SQUAD_EXTRAS_MAX). */
export type Squad = { id: string; ownerId: number; orchestratorId: string; groupIds: string[]; extraIds: string[] }
export const SQUAD_EXTRAS_MAX = 8
