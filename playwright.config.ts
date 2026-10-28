import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ownsDataDir = !process.env.PORTFOLIO_E2E_DATA_DIR;
const dataDir =
  process.env.PORTFOLIO_E2E_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'portfolio-e2e-'));
process.env.PORTFOLIO_E2E_DATA_DIR = dataDir;

export default defineConfig({
  metadata: { e2eDataDir: dataDir, ownsDataDir },
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  globalTeardown: './tests/e2e/teardown.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3089',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-board',
      testMatch: '**/{board,network}.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3089' },
    },
    {
      name: 'mobile-board',
      testMatch: '**/{board,network}.spec.ts',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        baseURL: 'http://127.0.0.1:3093',
      },
    },
    {
      name: 'desktop-port-layout',
      testMatch: '**/port-layout.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3095' },
    },
    {
      name: 'mobile-port-layout',
      testMatch: '**/port-layout.spec.ts',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        baseURL: 'http://127.0.0.1:3097',
      },
    },
    {
      name: 'desktop-network-presentation',
      testMatch: '**/network-presentation.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3099' },
    },
    {
      name: 'mobile-network-presentation',
      testMatch: '**/network-presentation.spec.ts',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        baseURL: 'http://127.0.0.1:3101',
      },
    },
    {
      name: 'desktop-port-inspector',
      testMatch: '**/port-inspector.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3103' },
    },
    {
      name: 'mobile-port-inspector',
      testMatch: '**/port-inspector.spec.ts',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        baseURL: 'http://127.0.0.1:3107',
      },
    },
  ],
  webServer: [3089, 3093, 3095, 3097, 3099, 3101, 3103, 3107].map(
    (port, index) => ({
      command: index === 0 ? 'pnpm build && pnpm start' : 'pnpm start',
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: join(dataDir, String(port)),
        PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      },
    }),
  ),
});
