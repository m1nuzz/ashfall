const key = 'ashfall.profile.token';
let token = '';
let profile = null;
try { token = localStorage.getItem(key) || ''; } catch { /* private mode: recovery code must be copied manually */ }
const el = id => document.getElementById(id);
const messages = { 'invalid-token': 'Неверный код восстановления. Введи сохранённый код; новый профиль автоматически не создаётся.', 'not-eligible': 'Награда доступна только топ-3 прошлой недели.', 'already-claimed': 'Награда за эту неделю уже выбрана.', 'not-owned': 'Этот облик ещё не получен.', 'rate-limit': 'Слишком много запросов. Подожди минуту.', 'invalid-name': 'Имя: 1–32 символа, без управляющих знаков.' };
export async function api(path, body, signal) {
  const response = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(messages[result.error] || result.error || 'Ошибка сервера');
  return result;
}
function remember(value) {
  token = value;
  try { localStorage.setItem(key, token); }
  catch { el('profile-storage-status').textContent = 'Хранилище недоступно. Обязательно скопируй код до закрытия страницы.'; }
}
export async function ensureProfile(name, signal) {
  const result = await api('profile', { ...(token ? { token } : {}), ...(name ? { name } : {}) }, signal);
  signal?.throwIfAborted();
  if (result.token) remember(result.token);
  profile = result.profile;
  paint();
  return { token, profile };
}
function paint() {
  if (!profile) return;
  el('create-profile').disabled = true;
  el('save-profile-name').disabled = false;
  el('profile-name').textContent = profile.name;
  el('profile-name-input').value = profile.name;
  el('player-name').value = profile.name;
  el('profile-summary').textContent = 'ID ' + profile.profileId.slice(0, 8) + ' · ' + (profile.rewardRank ? 'Топ-' + profile.rewardRank + ' прошлой недели' : 'Участник сообщества');
  el('profile-name').style.color = profile.nameColor || '';
  el('profile-name').classList.toggle('champion-name', !!profile.rewardRank);
  el('skin-status').textContent = 'Коллекция: ' + profile.rewards.join(', ') + '. Надет: ' + profile.skin;
  updateSkin();
}
function updateSkin() {
  const skin = el('profile-skin').value;
  el('skin-preview').dataset.skin = skin;
  el('claim-reward').disabled = !profile?.rewardRank || !!profile?.claimedSkin || skin === 'default';
  el('reward-status').textContent = profile?.claimedSkin ? 'Выбор этой недели сохранён: ' + profile.claimedSkin + '. Облик остаётся навсегда.' : profile?.rewardRank ? 'Ты в топ-3! Выбери один постоянный облик. Свечение имени действует только эту неделю.' : 'Места 1–3 прошлой недели могут выбрать один облик.';
  el('equip-skin').disabled = !profile?.rewards.includes(skin);
}
function table(id, rows) {
  el(id).replaceChildren();
  if (!rows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = 'Пока нет зачтённых игр.'; row.append(cell); el(id).append(row); return;
  }
  for (const peer of rows) {
    const row = document.createElement('tr');
    for (const field of ['rank', 'name', 'points', 'wins', 'games']) {
      const cell = document.createElement('td'); cell.textContent = String(peer[field]);
      if (field === 'name' && peer.nameColor) { cell.style.color = peer.nameColor; cell.className = 'champion-name'; }
      row.append(cell);
    }
    el(id).append(row);
  }
}
async function refresh() {
  el('board-status').textContent = 'Загрузка…';
  const board = await api('leaderboard');
  const date = value => new Date(value).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
  el('board-dates').textContent = date(board.weekStart) + ' — ' + date(board.weekEnd) + ' · понедельник 00:00 UTC';
  el('previous-dates').textContent = date(board.lastWeek.weekStart) + ' — ' + date(board.lastWeek.weekEnd);
  table('leaderboard-current', board.top20); table('leaderboard-previous', board.lastWeek.top3);
  const own = profile?.standing;
  el('own-rank').textContent = own ? `Твоё место: ${own.rank} · ${own.points} очков · ${own.games}/20 игр` : 'У профиля пока нет зачтённых игр этой недели.';
  el('board-status').textContent = 'Бой от 30 секунд; без выходов. Пара соперников засчитывается раз в сутки, максимум 20 игр в неделю.';
}
export function mountProfile(onIdentityChange) {
  let busy = false;
  const run = action => async () => {
    if (busy) return;
    busy = true;
    el('profile-status').textContent = '';
    try { await action(); } catch (error) { el('profile-status').textContent = error.message; el('board-status').textContent = error.message; } finally { busy = false; }
  };
  const open = run(async () => {
    el('profile-panel').hidden = false;
    el('recovery-code').hidden = true;
    if (token) await ensureProfile();
    await refresh();
  });
  for (const id of ['profile-btn', 'online-profile-btn']) el(id)?.addEventListener('click', open);
  el('close-profile').addEventListener('click', () => { el('profile-panel').hidden = true; el('recovery-code').textContent = ''; el('recovery-code').hidden = true; el('import-code').value = ''; });
  el('save-profile-name').disabled = !token;
  el('create-profile').disabled = !!token;
  for (const id of ['save-profile-name', 'create-profile']) el(id).addEventListener('click', run(async () => {
    onIdentityChange(); await ensureProfile(el('profile-name-input').value.trim() || 'Чародей'); await refresh();
  }));
  el('save-online-name').addEventListener('click', run(async () => { onIdentityChange(); await ensureProfile(el('player-name').value.trim()); }));
  el('reveal-recovery').addEventListener('click', () => { const hidden = el('recovery-code').hidden; el('recovery-code').textContent = hidden ? token || 'Сначала создай профиль.' : ''; el('recovery-code').hidden = !hidden; el('reveal-recovery').textContent = hidden ? 'Скрыть код' : 'Показать код'; });
  el('copy-recovery').addEventListener('click', run(async () => { if (!token) throw Error('Сначала создай профиль.'); await navigator.clipboard.writeText(token); el('profile-status').textContent = 'Секретный код скопирован. Храни его отдельно.'; }));
  el('import-profile').addEventListener('click', run(async () => {
    const value = el('import-code').value.trim();
    if (!value) throw Error('Введи код восстановления. Текущий профиль не изменён.');
    const result = await api('profile', { token: value });
    onIdentityChange(); remember(value); profile = result.profile; el('import-code').value = ''; el('recovery-code').hidden = true; el('recovery-code').textContent = ''; paint(); await refresh();
  }));
  el('profile-skin').addEventListener('change', updateSkin);
  for (const [id, path] of [['claim-reward', 'reward'], ['equip-skin', 'equip']]) el(id).addEventListener('click', run(async () => {
    const result = await api(path, { token, skin: el('profile-skin').value });
    profile = result.profile; paint(); el('profile-status').textContent = 'Сохранено. Новый облик появится при следующем входе в комнату.';
  }));
  el('refresh-leaderboard').addEventListener('click', run(async () => { if (token) await ensureProfile(); await refresh(); }));
  new MutationObserver(() => { if (el('profile-panel').hidden) { el('recovery-code').textContent = ''; el('recovery-code').hidden = true; el('import-code').value = ''; } }).observe(el('profile-panel'), { attributes: true, attributeFilter: ['hidden'] });
}
