import { expect, test } from '@playwright/test'
import { cleanupTemp, launch, newConsole } from './helpers'

test.afterEach(cleanupTemp)
// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the destructuring
test('Memory > Usage lists each console, NodShell and the total with real numbers', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const { app, page, errors } = await launch()
  try {
    await newConsole(page, 1)
    await newConsole(page, 2)
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    const dlg = page.getByRole('dialog', { name: 'Memory' })
    await dlg.getByRole('tab', { name: 'Usage' }).click()
    await expect(dlg.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await page.keyboard.press('Tab') // focus is on the selected tab: the next stop is the panel
    await expect(dlg.getByRole('tabpanel')).toBeFocused()
    await expect(dlg.getByTestId('usage-row')).toHaveCount(2, { timeout: 15_000 })
    const mem = (loc: ReturnType<typeof dlg.locator>) => loc.locator('td.num').innerText()
    for (const row of await dlg.getByTestId('usage-row').all()) expect(parseFloat(await mem(row))).toBeGreaterThan(0)
    expect(parseFloat(await mem(dlg.getByTestId('usage-app')))).toBeGreaterThan(0)
    expect(parseFloat(await mem(dlg.getByTestId('usage-total')))).toBeGreaterThan(0)
    await expect(dlg.getByTestId('memory-system')).toContainText('System')
    await expect(dlg.getByText('includes the MCP servers and plugins')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('memory-usage.png') })
    console.log(`screenshot: ${testInfo.outputPath('memory-usage.png')}`)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('past 80% of the RAM the warning shows once, offers the Usage tab and touches nothing', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch({ NODSHELL_TEST_AVAIL_MB: '1500' })
  try {
    await newConsole(page, 1)
    await newConsole(page, 2)
    const toast = page.getByRole('status').filter({ hasText: /Memory is at \d+%/ })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast).toHaveCount(0, { timeout: 25_000 }) // the toast times out (20 s, it carries an action)...
    await page.waitForTimeout(6000) // ...and the next report (5 s) does not bring it back
    await expect(toast).toHaveCount(0)
    await expect(page.getByTestId('terminal-node')).toHaveCount(2)
    await expect(page.locator('[data-paused]')).toHaveCount(0)
    await expect(page.getByTestId('live-badge')).toHaveAttribute('title', /system memory is at \d+%/)
  } finally {
    await app.close()
  }
})

test('the warning action opens the dialog on the Usage tab', async () => {
  test.setTimeout(60_000)
  const { app, page } = await launch({ NODSHELL_TEST_AVAIL_MB: '1500' })
  try {
    await page.getByRole('button', { name: 'See usage' }).click({ timeout: 15_000 })
    const dlg = page.getByRole('dialog', { name: 'Memory' })
    await expect(dlg.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true')
    await expect(dlg.getByTestId('memory-usage')).toBeVisible()
  } finally {
    await app.close()
  }
})
