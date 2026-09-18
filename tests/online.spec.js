import { test, expect } from '@playwright/test';
import { capture, tag, enterRoom } from './helpers.js';

test('online: lobby shop, readiness, countdown, fight effects and resume', async ({ browser }) => {
  test.setTimeout(240000);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const errors = [];
  const effects = [[], []];
  for (const [index, page] of [a, b].entries()) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type === 'effect') effects[index].push(message);
      } catch { /* non-JSON frame */ }
    }));
    await tag(page, index === 0 ? 'online-a' : 'online-b');
    await page.goto('/');
    await page.getByRole('button', { name: /ОНЛАЙН/ }).click();
  }
  await a.locator('#player-name').fill('Online Alpha');
  await b.locator('#player-name').fill('Online Beta');
  const code = await enterRoom(a, 'Online Alpha');
  expect(code).toMatch(/^[A-Z]{6}$/);
  await enterRoom(b, 'Online Beta', code);
  await expect(a.locator('#room-players li')).toHaveCount(2);
  await expect(a.locator('#online-shop button')).toHaveCount(6);
  await expect(a.locator('#online-gold')).toContainText('Золото: 8');
  await a.locator('#online-shop button[data-spell="fireball"]').click();
  await expect(a.locator('#online-gold')).toContainText('Золото: 0');
  await expect(a.locator('#online-shop button[data-spell="fireball"]')).toContainText('ур. 2');
  await capture(a, 'lobby-shop');
  await a.locator('#ready-online').click();
  await b.locator('#ready-online').click();
  await a.locator('#start-online').click();
  await a.locator('#room-countdown').waitFor({ state: 'visible', timeout: 5000 });
  await capture(a, 'countdown');
  for (const page of [a, b]) await page.locator('#pause').waitFor({ state: 'visible', timeout: 30000 });
  await expect(a.locator('#nameplates .nameplate')).toHaveCount(1);
  await expect(a.locator('#nameplates .nameplate').first()).toHaveText('Online Beta');
  for (const page of [a, b]) {
    await page.locator('#resume-btn').click();
    await expect(page.locator('#pause')).toBeHidden({ timeout: 10000 });
  }
  await capture(a, 'fight');
  await a.keyboard.press('2');
  await a.waitForTimeout(1000);
  expect(effects[0].length).toBeGreaterThan(0);
  const shared = effects[0].find(message => effects[1].some(other => other.id === message.id));
  expect(shared).toBeTruthy();
  expect(shared.spell).toBe('lightning');
  await b.reload();
  await b.getByRole('button', { name: /ОНЛАЙН/ }).click();
  await b.locator('#player-name').fill('Online Beta');
  await b.locator('#room-code-input').fill(code);
  await b.locator('#join-room').click();
  await b.locator('#room-lobby').waitFor({ state: 'visible', timeout: 20000 });
  await expect(b.locator('#room-players li')).toHaveCount(2);
  await expect(a.locator('#room-players li')).toHaveCount(2);
  await capture(b, 'resumed');
  await b.locator('#leave-online').click();
  await a.locator('#leave-online').click();
  await expect(a.locator('#menu')).toBeVisible();
  expect(errors).toEqual([]);
  await contextA.close();
  await contextB.close();
});
