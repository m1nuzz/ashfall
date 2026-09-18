export default {
  testDir: 'tests',
  outputDir: 'test-results',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, screenshot: 'only-on-failure', video: { mode: 'retain-on-failure', dir: 'artifacts/videos' }, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
};
