// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 20000,
  retries: 1,
  reporter: 'list',
  use: {
    headless: true,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  },
});
