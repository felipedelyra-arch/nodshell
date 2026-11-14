// Zod-free preset rules shared by main (domain) and the renderer (inline validation).
import { MODEL_CHOICES, PROMPT_MAX, ROLE_RE, type ModelChoice } from './agent'

export const PRESET_NAME_MAX = 40
export const GROUP_NAME_MAX = 40
// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\u0000-\u001f\u007f]/

export type PresetFields = { name: string; role: string; model: ModelChoice | null; systemPrompt: string }
export type PresetErrors = Partial<Record<keyof PresetFields, string>>

/** The name is trimmed; `model` null means the CLI default. */
export function validatePreset(p: PresetFields): { ok: true; value: PresetFields } | { ok: false; errors: PresetErrors } {
  const errors: PresetErrors = {}
  const name = p.name.trim()
  if (name.length < 1 || name.length > PRESET_NAME_MAX) errors.name = `Name must be 1 to ${PRESET_NAME_MAX} characters.`
  else if (CONTROL_RE.test(name)) errors.name = 'Name cannot contain control characters.'
  if (!ROLE_RE.test(p.role)) errors.role = 'Use lowercase letters, digits and dashes, starting with a letter (up to 24).'
  if (p.model !== null && !(MODEL_CHOICES as readonly string[]).includes(p.model)) errors.model = 'Unknown model.'
  if (p.systemPrompt.length > PROMPT_MAX) errors.systemPrompt = `System prompt is limited to ${PROMPT_MAX} characters.`
  else if (p.systemPrompt.includes('\0')) errors.systemPrompt = 'System prompt cannot contain null characters.'
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { ...p, name } }
}
