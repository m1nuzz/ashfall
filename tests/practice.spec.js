import { test, expect } from '@playwright/test';
import { capture, tag } from './helpers.js';

const waitForShop = page => page.waitForFunction(() => document.querySelector('#shop')?.hidden === false, null, { timeout: 180000 });

test('practice tournament: combat, rounds, shop purchases and reset', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await tag(page, 'practice');
  await page.goto('/');
  await page.getByRole('button', { name: /БОЙ С БОТАМИ/ }).click();
  await page.locator('#hud').waitFor({ state: 'visible', timeout: 15000 });
  await expect(page.locator('#round')).toHaveText('Раунд 1/5');
  await page.mouse.click(400, 300);
  await page.mouse.move(10, 10);
  for (let i = 0; i < 5; i++) {
    if (await page.locator('#shop').isVisible()) break;
    await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
    await page.keyboard.press('Digit2'); await page.keyboard.press('Digit3');
    await page.waitForTimeout(300);
  }
  await capture(page, 'combat');
  await expect(page.locator('#alive')).toContainText('Живых');
  await expect(page.locator('#spellbar .spell')).toHaveCount(6);
  for (let round = 1; round <= 5; round++) {
    await waitForShop(page);
    const title = await page.locator('#shop-title').innerText();
    if (round === 5) expect(title).toBe('Турнир завершён');
    else {
      expect(['Арена твоя', 'Пламя победило']).toContain(title);
      await expect(page.locator('#shop-subtitle')).toContainText(`Раунд ${round}/5`);
    }
    const firstCard = page.locator('#shop-items .shop-card:not([disabled])').first();
    if (round === 1) {
      await expect(page.locator('#shop-items .shop-card')).toHaveCount(6);
      const goldBefore = await page.locator('#shop-gold').innerText();
      const textBefore = await firstCard.innerText();
      await firstCard.click();
      const goldAfter = await page.locator('#shop-gold').innerText();
      expect(goldAfter).not.toBe(goldBefore);
      expect(textBefore).toMatch(/◆◇◇◇/);
      const textAfter = await page.locator('#shop-items .shop-card').first().innerText();
      expect(textAfter).toMatch(/◆◆◇◇/);
    }
    await capture(page, `shop-round-${round}`);
    await page.locator('#next-btn').click();
    if (round < 5) {
      await expect(page.locator('#round')).toHaveText(`Раунд ${round + 1}/5`);
      await page.mouse.click(400, 300);
    }
  }
  await capture(page, 'new-tournament-start');
  await expect(page.locator('#round')).toHaveText('Раунд 1/5');
  await page.mouse.click(400, 300);
  await waitForShop(page);
  await expect(page.locator('#shop-title')).toHaveText(/Арена твоя|Пламя победило/);
  await page.locator('#shop-menu').click();
  await expect(page.locator('#menu')).toBeVisible();
  expect(errors).toEqual([]);
});
