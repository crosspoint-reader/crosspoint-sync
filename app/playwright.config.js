import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.browser.js',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:1420' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:1420/tests/optimizer.html',
    reuseExistingServer: !process.env.CI,
  },
})
