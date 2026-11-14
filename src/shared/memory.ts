// Zod-free memory rules shared by main (store, IPC schemas, MCP tools) and the renderer (size counter).
export const MEMORY_SCOPES = ['global', 'repo'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]
/** Bytes of UTF-8 per memory text. */
export const MEMORY_MAX = 64 * 1024
/** "you" or an agent's short name. */
export const MEMORY_EDITOR_RE = /^(?:you|[A-Z][a-z]{1,4}(?:[2-9]|[1-9]\d{1,2})?)$/

const encoder = new TextEncoder()
export const memoryBytes = (text: string): number => encoder.encode(text).length

/** Text only: CRLF becomes LF and control characters go, except line breaks and tabs. */
export function cleanMemory(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}
