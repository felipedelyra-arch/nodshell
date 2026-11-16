import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cleanupTemp, launch } from './helpers'
import { setupRepo, spawnAgent } from './repo'

test.afterEach(cleanupTemp)

test('a folder without git opens as it is: agents work inside it, and closing them leaves the folder untouched', async () => {
  test.setTimeout(60_000)
  const r = setupRepo() // only for the fake claude and its logs
  const plain = join(dirname(r.repo), 'plain folder')
  mkdirSync(plain)
  writeFileSync(join(plain, 'notes.txt'), 'mine\n')
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_REPO: plain, NODSHELL_TEST_CLOSE: 'yes' })
  try {
    await page.getByRole('button', { name: 'Open folder' }).click()
    await expect(page.getByTestId('repo-badge')).toHaveText('no git')
    await spawnAgent(page, 'builder', 'opus', 1)
    await spawnAgent(page, 'builder', 'sonnet', 2)
    const cards = page.getByTestId('agent-node')
    for (const i of [0, 1]) await expect(cards.nth(i).getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    expect(r.runs().map((x) => x.cwd)).toEqual([realpathSync(plain), realpathSync(plain)])

    await cards.nth(0).getByRole('button', { name: /close/i }).click()
    await expect(cards).toHaveCount(1)
    expect(existsSync(join(plain, 'notes.txt'))).toBe(true)
    expect(existsSync(join(plain, '.git'))).toBe(false)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
  expect(existsSync(join(plain, 'notes.txt'))).toBe(true)
})
