import { test, expect } from '@playwright/test';

test('audio unlocks, plays real decoded buffers and mute silences output', async ({ page }) => {
  test.setTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.evaluate(() => {
    window.__starts = 0;
    const original = window.AudioContext.prototype.createBufferSource;
    window.AudioContext.prototype.createBufferSource = function (...args) {
      const source = original.apply(this, args);
      const start = source.start.bind(source);
      source.start = (...started) => { window.__starts += 1; return start(...started); };
      return source;
    };
  });
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.locator('#audio-preview').click();
  await page.waitForFunction(() => window.__starts > 0, null, { timeout: 15000 });
  expect(await page.evaluate(() => window.__starts)).toBeGreaterThan(0);
  await page.locator('#volume').evaluate(element => {
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#volume-value')).toHaveText('0%');
  const before = await page.evaluate(() => window.__starts);
  await page.locator('#audio-preview').click();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__starts)).toBe(before);
  await page.reload();
  await page.evaluate(() => {
    window.__starts = 0;
    const original = window.AudioContext.prototype.createBufferSource;
    window.AudioContext.prototype.createBufferSource = function (...args) {
      const source = original.apply(this, args);
      const start = source.start.bind(source);
      source.start = (...started) => { window.__starts += 1; return start(...started); };
      return source;
    };
  });
  await page.getByRole('button', { name: 'Настройки' }).click();
  await expect(page.locator('#volume-value')).toHaveText('0%');
  await page.locator('#volume').evaluate(element => {
    element.value = '0.65';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#audio-preview').click();
  await page.waitForFunction(() => window.__starts > 0, null, { timeout: 15000 });
  expect(errors).toEqual([]);
});
