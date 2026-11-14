import { describe, expect, it } from 'vitest'
import { buildCsp, buildWebPreferences, isAllowedNavigation, resolveAppPath } from '../../src/main/security'

describe('webPreferences', () => {
  it('has the exact security flags', () => {
    expect(buildWebPreferences('/p/preload.js')).toEqual({
      preload: '/p/preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
  })
})

describe('CSP', () => {
  const prod = buildCsp(false)
  it('is strict in production', () => {
    const dir = (n: string) => prod.split('; ').find((d) => d.startsWith(n + ' ')) ?? ''
    expect(dir('script-src')).not.toContain('unsafe-inline')
    expect(dir('style-src')).toBe("style-src 'self' 'unsafe-inline'") // xterm runtime <style> elements and truecolor attributes
    expect(dir('style-src-elem')).toBe('')
    expect(dir('img-src')).toBe("img-src 'self' data:")
    expect(dir('font-src')).toBe("font-src 'self'")
    expect(prod).not.toContain('unsafe-eval')
    expect(prod).toContain("default-src 'none'")
    expect(prod).toContain("object-src 'none'")
    expect(prod).toContain("connect-src 'none'")
  })
  it('dev allows inline scripts (react-refresh preamble) but never unsafe-eval; prod never allows inline scripts', () => {
    const dev = buildCsp(true)
    expect(dev).toContain("script-src 'self' 'unsafe-inline'")
    expect(dev).not.toContain('unsafe-eval')
    expect(prod.split('; ').find((d) => d.startsWith('script-src '))).not.toContain('unsafe-inline')
  })
})

describe('isAllowedNavigation', () => {
  it('accepts only the app origin', () => {
    expect(isAllowedNavigation('app://app/index.html', 'app://app')).toBe(true)
    expect(isAllowedNavigation('https://example.com', 'app://app')).toBe(false)
    expect(isAllowedNavigation('file:///etc/passwd', 'app://app')).toBe(false)
    expect(isAllowedNavigation('file:///etc/passwd', 'http://localhost:5173')).toBe(false)
    expect(isAllowedNavigation('not a url', 'app://app')).toBe(false)
    expect(isAllowedNavigation('', 'app://app')).toBe(false)
  })
})

describe('resolveAppPath', () => {
  it('resolves normal paths under the root', () => {
    expect(resolveAppPath('/assets/a.js', '/r')).toEqual({ ok: true, file: '/r/assets/a.js' })
  })
  it.each(['/%E0%A4%A', '/..%2Fsecret', '/../secret', '/a/%2e%2e/b', '/a%00b'])('rejects %s', (p) => {
    expect(resolveAppPath(p, '/r')).toEqual({ ok: false })
  })
})
