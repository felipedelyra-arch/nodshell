import { TASKS_MAX, TASKS_RECENT } from '../../shared/flow'
import { isFinished, taskStatus, taskTitle, type Assignee, type RecipientState, type Task, type TaskStatus } from '../domain/task'

/** What the delivery queue did with a task's message for one recipient. */
export type DeliveryEvent = 'queued' | 'delivered' | 'returned' | 'dropped'
/** Only titles and states: a message's full text never leaves the board. `latest`: per assignee id (agent or group), the state of its latest task (the board's edges show it). */
export type TaskSummary = { squadId: string; done: number; total: number; recent: { title: string; assignee: string; status: TaskStatus }[]; latest: { id: string; status: TaskStatus }[] }

const NEXT: Record<DeliveryEvent, RecipientState> = { queued: 'queued', delivered: 'running', returned: 'queued', dropped: 'failed' }

/**
 * The tasks of every squad, in memory (persistence is F8), at most TASKS_MAX per squad (the oldest finished go first).
 * A task is running from its delivery and done once its recipient ends the turn after it (a group: every member that got it);
 * a recipient closed, exited or in error before that fails it. Each change is reported per squad.
 */
export class TaskBoard {
  private tasks = new Map<string, Task>() // in creation order
  constructor(
    private emit: (ownerId: number, s: TaskSummary) => void,
    private newId: () => string,
    private now: () => number = Date.now,
  ) {}

  /** `text`: the message; only its first line is kept, as the title. */
  create(ownerId: number, squadId: string, text: string, assignee: Assignee, recipientIds: string[]): Task {
    const t: Task = { id: this.newId(), ownerId, squadId, title: taskTitle(text), assignee, status: 'queued', createdAt: this.now(), recipients: new Map(recipientIds.map((id) => [id, 'new'])) }
    this.tasks.set(t.id, t)
    const mine = this.list(squadId)
    for (let over = mine.length - TASKS_MAX; over > 0; over--) {
      const victim = mine.find((x) => isFinished(x.status)) ?? mine[0]!
      this.tasks.delete(victim.id)
      mine.splice(mine.indexOf(victim), 1)
    }
    this.changed(ownerId, squadId)
    return t
  }

  list(squadId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.squadId === squadId)
  }

  /** The queue took, delivered, put back or dropped these tasks' message for `agentId`. A finished recipient stays as it is. */
  track(agentId: string, taskIds: string[], e: DeliveryEvent): void {
    for (const id of taskIds) {
      const t = this.tasks.get(id)
      const r = t?.recipients.get(agentId)
      if (t && r !== undefined && !isFinished(r)) this.set(t, agentId, NEXT[e])
    }
  }

  /** After the send: a recipient the queue never took (refused, too many waiting, a guard) has failed. */
  settle(taskId: string): void {
    const t = this.tasks.get(taskId)
    if (t) for (const [id, r] of t.recipients) if (r === 'new') this.set(t, id, 'failed')
  }

  /** The agent ended a turn (Stop): whatever was delivered to it is done. Call before anything new is delivered on this Stop. */
  stopped(agentId: string): void {
    for (const t of this.tasks.values()) if (t.recipients.get(agentId) === 'running') this.set(t, agentId, 'done')
  }

  /** The agent was closed, exited or is in error: what it had not finished has failed. */
  down(agentId: string): void {
    for (const t of this.tasks.values()) {
      const r = t.recipients.get(agentId)
      if (r !== undefined && !isFinished(r)) this.set(t, agentId, 'failed')
    }
  }

  dropSquad(squadId: string): void {
    for (const t of this.list(squadId)) this.tasks.delete(t.id)
  }

  dropOwner(ownerId: number): void {
    for (const t of [...this.tasks.values()]) if (t.ownerId === ownerId) this.tasks.delete(t.id)
  }

  summary(squadId: string): TaskSummary {
    const mine = this.list(squadId)
    const recent = mine.slice(-TASKS_RECENT).reverse().map((t) => ({ title: t.title, assignee: t.assignee.name, status: t.status }))
    const latest = new Map(mine.map((t) => [t.assignee.id, t.status])) // in creation order: the last one wins
    return { squadId, done: mine.filter((t) => t.status === 'done').length, total: mine.length, recent, latest: [...latest].map(([id, status]) => ({ id, status })) }
  }

  private set(t: Task, agentId: string, r: RecipientState): void {
    t.recipients.set(agentId, r)
    t.status = taskStatus(t.recipients.values())
    this.changed(t.ownerId, t.squadId)
  }

  private changed(ownerId: number, squadId: string): void {
    this.emit(ownerId, this.summary(squadId))
  }
}
