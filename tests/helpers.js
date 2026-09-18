import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function openOnline(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /ОНЛАЙН/ }).click();
  await page.locator('#online-panel').waitFor({ state: 'visible' });
}

export async function enterRoom(page, name, code = '') {
  await page.locator('#player-name').fill(name);
  if (code) await page.locator('#room-code-input').fill(code);
  await page.locator(code ? '#join-room' : '#create-room').click();
  await page.locator('#room-lobby').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#room-code').filter({ hasText: /^[A-Z]{6}$/ }).waitFor({ timeout: 20000 });
  return page.locator('#room-code').innerText();
}

export async function roomCode(page) {
  return page.locator('#room-code').innerText();
}

export async function capture(page, name) {
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: join('artifacts/screenshots', `${page._ashfallTag ?? 'client'}-${name}.png`) });
}

export async function tag(page, label) {
  page._ashfallTag = label;
}

export async function status(page) {
  return page.locator('#online-status').innerText();
}
