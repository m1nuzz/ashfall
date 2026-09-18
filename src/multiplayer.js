import { ensureProfile, mountProfile } from './profile.js';

export function createMultiplayer({ onState, onLeave, onMatch, onEffect }) {
  const el = id => document.getElementById(id);
  let socket = null;
  let identity = null;
  let room = null;
  let lastPhase = null;
  let pending = null;
  const status = text => { el('online-status').textContent = text; };
  const translations = {
    'Room not found': 'Комната не найдена.',
    'Room is full': 'Комната заполнена.',
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
    el('ready-online').textContent = ready ? 'СНЯТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
    el('ready-online').setAttribute('aria-pressed', String(!!ready));
    el('ready-online').disabled = room.phase === 'fight';
    el('room-countdown').hidden = room.phase !== 'countdown';
    el('countdown-value').textContent = Math.ceil(room.countdown || 0);
    el('countdown-meter').value = room.countdown || 0;
    el('start-online').textContent = room.phase === 'finished' ? 'РЕВАНШ →' : 'НАЧАТЬ БОЙ →';
    if (room.phase === 'lobby') status(host ? 'Поделись кодом. Для старта нужно минимум 2 игрока.' : 'Ожидание старта от хозяина комнаты.');
  }
  function disconnect(notify = true) {
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
    let account;
    try { account = await ensureProfile(name); }
    catch (error) { status(error.message); return; }
    finally { connecting = false; }
    pending = action === 'create' ? { type: 'create', name: account.profile.name } : { type: 'join', name: account.profile.name, code: el('room-code-input').value.trim().toUpperCase() };
    if (socket?.readyState === WebSocket.OPEN) { send(pending); pending = null; return; }
    status('Подключение к серверу…');
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    const current = socket;
    const timer = setTimeout(() => {
      if (socket === current && current.readyState !== WebSocket.OPEN) current.close();
    }, 8000);
    current.onopen = () => clearTimeout(timer);
    current.onmessage = event => {
      if (socket !== current) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') { identity = message.id; send({ type: 'authenticate', token: account.token }); }
      if (message.type === 'profile') { if (pending) send(pending); pending = null; }
      if (message.type === 'effect') onEffect?.(message);
      if (message.type === 'error') { pending = null; status(translations[message.message] || message.message); }
      if (message.type === 'room') { room = message; paintRoom(); }
      if (message.type === 'state') {
        if (!room) return;
        room.phase = message.phase;
        room.countdown = message.countdown;
        room.players = message.players;
        if (message.phase === 'countdown' || message.phase === 'lobby') paintRoom();
        if (message.phase === 'fight' && lastPhase !== 'fight') {
          el('online-panel').hidden = true;
          onMatch(identity);
        }
        onState(message, identity);
        if (message.phase === 'finished') {
          el('online-panel').hidden = false;
          const winner = message.players.find(peer => peer.id === message.winner);
          status(winner ? `${winner.name} побеждает. Хозяин может начать реванш.` : 'Ничья. Можно начать реванш.');
          paintRoom();
        }
        lastPhase = message.phase;
      }
    };
    current.onerror = () => status('Сервер недоступен. Запусти npm run dev и проверь соединение.');
    current.onclose = () => {
      clearTimeout(timer);
      if (socket !== current) return;
      disconnect();
      el('online-panel').hidden = false;
      status('Связь с сервером потеряна. Создай комнату или подключись снова.');
    };
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
