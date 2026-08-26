import { defineConfig } from '@playwright/test'

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
      url: 'http://127.0.0.1:4174/api/sessions',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: 'wide-light', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'wide-dark', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
    { name: 'narrow-light', use: { viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true } },
    { name: 'narrow-dark', use: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true } },
  ],
})
