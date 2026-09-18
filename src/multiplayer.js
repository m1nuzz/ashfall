import { ensureProfile, mountProfile } from './profile.js';

export function createMultiplayer({ onState, onLeave, onMatch, onEffect }) {
  const el = id => document.getElementById(id);
  let socket = null;
  let identity = null;
  let room = null;
  let lastPhase = null;
  let pending = null;
  let authenticated = false;
  let controller = null;
  let attempt = 0;
  const status = text => { el('online-status').textContent = text; };
  const translations = {
    'Room not found': 'Комната не найдена.',
    'Room is full': 'Комната заполнена.',
    'Profile already connected': 'Профиль открыт в другом окне. Закрой его и повтори вход.',
    'Invalid token': 'Код профиля недействителен. Открой восстановление профиля.',
    'Shop is closed': 'Покупки закрыты: сними готовность или дождись конца раунда.',
    'Not enough gold': 'Недостаточно золота.',
    'Match already in progress': 'Бой уже идёт. Восстановление доступно прежним участникам.',
  };
  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  function paintRoom() {
    if (!room) return;
    el('room-connect').hidden = true;
    el('room-lobby').hidden = false;
    el('room-code').textContent = room.code;
    el('room-players').replaceChildren(...room.players.map(peer => {
      const row = document.createElement('li');
      row.textContent = `${peer.name}${peer.id === identity ? ' · ты' : ''}${peer.id === room.host ? ' · хозяин' : ''} · ${peer.ready ? 'ГОТОВ' : 'подготовка'}`;
      if (peer.nameColor) { row.style.color = peer.nameColor; row.className = 'champion-name'; }
      return row;
    }));
    const host = room.host === identity;
    el('start-online').disabled = !host || room.players.length < 2 || !room.players.every(p => p.ready) || !['lobby', 'finished'].includes(room.phase);
    const ready = room.players.find(p => p.id === identity)?.ready;
    el('ready-online').setAttribute('aria-pressed', String(!!ready));
    el('ready-online').textContent = ready ? 'СНЯТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
    el('ready-online').disabled = room.phase === 'fight';
    el('online-round').textContent = room.round >= 5 ? 'Турнир завершён · 5 раундов' : `Раунд ${Math.min(5, (room.round || 0) + 1)}/5 · покупки до готовности`;
    const local = room.players.find(p => p.id === identity);
    el('online-gold').textContent = `Золото: ${local?.gold ?? 8} · Победы: ${local?.wins ?? 0}`;
    paintShop(local);
    el('room-countdown').hidden = room.phase !== 'countdown';
    el('countdown-value').textContent = Math.ceil(room.countdown || 0);
    el('countdown-meter').value = room.countdown || 0;
    el('start-online').textContent = room.round >= 5 ? 'НОВЫЙ ТУРНИР →' : room.phase === 'finished' ? 'СЛЕДУЮЩИЙ РАУНД →' : 'НАЧАТЬ БОЙ →';
    if (room.phase === 'lobby') status(host ? 'Поделись кодом. Для старта нужно минимум 2 игрока.' : 'Ожидание старта от хозяина комнаты.');
  }
  function disconnect(notify = true) {
    attempt++;
    controller?.abort();
    connecting = false;
    authenticated = false;
    if (socket?.readyState === WebSocket.OPEN) send({ type: 'leave' });
    const current = socket;
    socket = null;
    pending = null;
    room = null;
    identity = null;
    lastPhase = null;
    if (current) { current.onclose = null; current.close(); }
    el('online-panel').hidden = true;
    el('room-connect').hidden = false;
    el('room-lobby').hidden = true;
    if (notify) onLeave();
  }
  let connecting = false;
  async function connect(action) {
    if (pending || connecting) return;
    const name = el('player-name').value.trim().slice(0, 32);
    if (!name) return status('Укажи имя мага.');
    if (action === 'join' && !/^[A-Z]{6}$/.test(el('room-code-input').value.trim().toUpperCase())) return status('Код состоит из шести латинских букв.');
    connecting = true;
    const generation = ++attempt;
    controller = new AbortController();
    let account;
    try { account = await ensureProfile(name, controller.signal); }
    catch (error) { if (generation === attempt) status(error.message); return; }
    finally { connecting = false; }
    if (generation !== attempt) return;
    pending = action === 'create' ? { type: 'create', name: account.profile.name } : { type: 'join', name: account.profile.name, code: el('room-code-input').value.trim().toUpperCase() };
    if (socket?.readyState === WebSocket.OPEN && authenticated) { send(pending); pending = null; return; }
    status('Подключение к серверу…');
    if (socket) { socket.onclose = null; socket.close(); }
    authenticated = false;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    const current = socket;
    const timer = setTimeout(() => {
      if (socket === current && !authenticated) current.close();
    }, 8000);
    current.onopen = () => status('Проверка профиля…');
    current.onmessage = event => {
      if (socket !== current) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') { identity = message.id; if (!message.resumed) send({ type: 'authenticate', token: account.token }); }
      if (message.type === 'profile') { authenticated = true; clearTimeout(timer); if (pending && !message.resumed) send(pending); pending = null; }
      if (message.type === 'effect') onEffect?.(message);
      if (message.type === 'error') { pending = null; status(translations[message.message] || 'Запрос отклонён сервером: ' + message.message); if (!authenticated) { clearTimeout(timer); current.onclose = null; current.close(); socket = null; } }
      if (message.type === 'room') { room = message; paintRoom(); }
      if (message.type === 'state') {
        if (!room) return;
        room.phase = message.phase;
        room.countdown = message.countdown;
        room.players = message.players;
        room.round = message.round;
        if (message.phase !== 'fight') paintRoom();
        if (message.phase === 'fight' && lastPhase !== 'fight') {
          el('online-panel').hidden = true;
          onMatch(identity);
        }
        onState(message, identity);
        if (message.phase === 'finished') {
          el('online-panel').hidden = false;
          const winner = message.players.find(peer => peer.id === message.winner);
          const standings = [...message.players].sort((a, b) => b.wins - a.wins).map(p => `${p.name}: ${p.wins}`).join(' · ');
          status((winner ? `${winner.name} побеждает. ` : 'Ничья. ') + (message.round >= 5 ? 'Итог турнира — ' + standings : 'Подготовься к следующему раунду.') + (message.settlement?.scored ? ' Очки недели зачтены.' : ' Этот раунд не зачтён в неделю: длительность, выходы, дневная пара или лимит.'));
          paintRoom();
        }
        lastPhase = message.phase;
      }
    };
    current.onerror = () => status('Сервер недоступен. Проверь соединение и повтори вход.');
    current.onclose = () => {
      clearTimeout(timer);
      if (socket !== current) return;
      if (room) el('room-code-input').value = room.code;
      disconnect();
      el('online-panel').hidden = false;
      status('Связь потеряна. Нажми «Войти» в течение 20 секунд: профиль восстановит место. Бой не приостанавливается; после обрыва очки недели не начисляются.');
    };
  }
  let shopKey = '';
  function paintShop(local) {
    const next = JSON.stringify([room.phase, room.round, local?.gold, local?.levels, local?.ready]);
    if (shopKey === next) return;
    shopKey = next;
    const items = [['fireball','Огнешар',5],['lightning','Молния',7],['homing','Охотник',6],['meteor','Метеор',8],['blink','Рывок',6],['shield','Щит',6]];
    el('online-shop').replaceChildren(...items.map(([spell, name, base]) => {
      const level = local?.levels?.[spell] ?? 1;
      const cost = Math.round(base * 1.6 ** level);
      const button = document.createElement('button');
      button.dataset.spell = spell;
      button.textContent = `${name} · ур. ${level} · ${level >= 4 ? 'MAX' : cost + ' зол.'}`;
      button.disabled = local?.ready || !['lobby', 'finished'].includes(room.phase) || room.round >= 5 || level >= 4 || cost > (local?.gold ?? 8);
      button.onclick = () => send({ type: 'buy', spell });
      return button;
    }));
  }
  el('online-btn').addEventListener('click', () => { el('online-panel').hidden = false; });
  el('create-room').addEventListener('click', () => connect('create'));
  el('join-room').addEventListener('click', () => connect('join'));
  mountProfile(() => disconnect());
  el('ready-online').addEventListener('click', () => send({ type: 'ready', ready: !room?.players.find(p => p.id === identity)?.ready }));
  el('start-online').addEventListener('click', () => send({ type: 'start' }));
  el('leave-online').addEventListener('click', () => disconnect());
  el('copy-room').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(room.code); status('Код скопирован. Отправь его вместе со ссылкой на сайт.'); }
    catch { status(`Скопируй код вручную: ${room?.code || ''}`); }
  });
  return { send, disconnect, get connected() { return socket?.readyState === WebSocket.OPEN; } };
}
