/** Where a bare key (Space for voice, a tool letter, Delete) keeps its own meaning: fields, buttons, menus, dialogs and every terminal. */
export const KEEPS_KEYS = 'input, textarea, select, button, a, summary, [contenteditable], [role=dialog], [role=menu], [role=menuitem], [role=listbox], [role=option], [role=tab], [role=combobox], [role=button], .xterm, .term-body, dialog'

/** The focus is on the board itself (or nowhere): not in a terminal, a field, a control or while a dialog is open. */
export function onBoard(target: EventTarget | null): boolean {
  if (document.querySelector('[aria-modal=true], dialog[open]')) return false
  if (!(target instanceof Element) || target === document.body) return true
  return !target.closest(KEEPS_KEYS) && target.closest('.react-flow, .annotation-overlay, .annotation-item') !== null
}
