// Pure module: must not import `electron` so it stays unit-testable.

export function buildWebPreferences(preloadPath: string) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  } as const
}

/** devOrigin is the Vite dev server origin, e.g. http://localhost:5173 (dev only). */
export function buildCsp(isDev: boolean, devOrigin = 'http://localhost:5173'): string {
  const wsOrigin = devOrigin.replace(/^http/, 'ws')
  const directives = isDev
    ? [
        "default-src 'none'",
        // Vite's React plugin injects an inline react-refresh preamble script
        `script-src 'self' 'unsafe-inline' ${devOrigin}`,
        // Vite HMR injects inline styles
        `style-src 'self' 'unsafe-inline' ${devOrigin}`,
        // board images come from the app:// protocol, a different origin than the dev server
        "img-src 'self' data: app://app",
        "font-src 'self'",
        `connect-src ${devOrigin} ${wsOrigin}`,
      ]
    : [
        "default-src 'none'",
        "script-src 'self'",
        // xterm's DOM renderer needs runtime <style> elements (theme, cell size) and inline style attributes (truecolor cells)
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'",
      ]
  return [
    ...directives,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function isAllowedNavigation(url: string, appOrigin: string): boolean {
  try {
    const u = new URL(url)
    const a = new URL(appOrigin)
    // compare scheme+host+port (URL.origin is "null" for custom schemes in Node); empty host (file:) never matches
    return a.host !== '' && u.protocol === a.protocol && u.host === a.host
  } catch {
    return false
  }
}

export type ResolvedPath = { ok: true; file: string } | { ok: false }

/** Maps an app:// pathname to a file under rootDir (posix-style join); rejects malformed escapes and traversal. */
export function resolveAppPath(pathname: string, rootDir: string): ResolvedPath {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { ok: false }
  }
  if (decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) return { ok: false }
  const root = rootDir.replace(/\/+$/, '')
  return { ok: true, file: `${root}/${decoded.replace(/^\/+/, '')}` }
}

/** The only permission ever granted: the microphone (audio and nothing else) for a page at the app's own origin. */
export function isMicrophoneAllowed(permission: string, mediaTypes: readonly string[] | undefined, url: string, appOrigin: string): boolean {
  return permission === 'media' && mediaTypes?.length === 1 && mediaTypes[0] === 'audio' && isAllowedNavigation(url, appOrigin)
}
