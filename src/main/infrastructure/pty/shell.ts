/** $SHELL if it is listed in /etc/shells (content passed in), else /bin/bash. */
export function pickShell(envShell: string | undefined, etcShells: string): string {
  if (envShell && envShell.startsWith('/')) {
    const listed = etcShells
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    if (listed.includes(envShell)) return envShell
  }
  return '/bin/bash'
}

const DROP = [/^ELECTRON_/, /^NODE_OPTIONS$/, /^VITE_/, /^VITE$/, /^NODSHELL_/]

export function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || DROP.some((r) => r.test(k))) continue
    out[k] = v
  }
  out['TERM'] = 'xterm-256color'
  return out
}
