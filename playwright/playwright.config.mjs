import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: process.env.CI
    ? [['list'], ['html', {open: 'never'}]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8942',
    headless: true,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npx grunt build buildtests && node playwright/serve.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:8942/test/test.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
