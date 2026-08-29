import { defineConfig } from '@playwright/test'
import { APP_URL } from './test/browser/app-url.js'

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node test/browser/static-server.mjs',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node --import tsx test/browser/app-server.ts',
      url: APP_URL + '/api/sessions',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  // `colorScheme` stays the emulated system preference, which the product deliberately ignores now
  // that light is the only default; `metadata.theme` is the theme a project actually asks for, and
  // test/browser/theme.ts turns it into a `theme=dark` hash or a stored landing preference.
  projects: [
    { name: 'wide-light', metadata: { theme: 'light' }, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'wide-dark', metadata: { theme: 'dark' }, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
    { name: 'narrow-light', metadata: { theme: 'light' }, use: { viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true } },
    { name: 'narrow-dark', metadata: { theme: 'dark' }, use: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true } },
  ],
})
