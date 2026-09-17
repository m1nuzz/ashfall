const files = Object.freeze({ fireball: 'fireball.ogg', homing: 'magic.ogg', lightning: 'lightning.ogg', meteor: 'hit.ogg', hit: 'hit.ogg', blink: 'blink.ogg', shield: 'magic.ogg', ui: 'ui.ogg', victory: 'victory.ogg' });

export function createAudio(getVolume, report = () => {}) {
  let context = null;
  let master = null;
  let loading = null;
  let generation = 0;
  const buffers = new Map();
  const voices = new Set();
  const lastPlayed = new Map();
  function volume() {
    const value = getVolume();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }
  async function unlock() {
    try {
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        master.connect(context.destination);
      }
      master.gain.value = volume();
      if (context.state === 'suspended') await context.resume();
      if (!loading) {
        loading = Promise.all([...new Set(Object.values(files))].map(async file => {
          try {
            const response = await fetch('/assets/audio/' + file, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            buffers.set(file, await context.decodeAudioData(await response.arrayBuffer()));
          } catch { report('Не удалось загрузить звук: ' + file); }
        }));
      }
      await loading;
      return context.state === 'running';
    } catch { report('Звук недоступен в этом браузере.'); return false; }
  }
  function play(name, options = {}) {
    if (!context || context.state !== 'running' || volume() === 0) return;
    const buffer = buffers.get(files[name]);
    if (!buffer) return;
    const now = context.currentTime;
    if (now - (lastPlayed.get(name) ?? -Infinity) < (name === 'hit' ? 0.12 : 0.045)) return;
    lastPlayed.set(name, now);
    if (voices.size >= 20) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const pan = context.createStereoPanner();
    source.buffer = buffer;
    source.playbackRate.value = name === 'meteor' ? 0.65 : 1;
    gain.gain.value = Math.max(0, Math.min(1, options.gain ?? (name === 'ui' ? 0.35 : 0.65)));
    pan.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
    source.connect(gain).connect(pan).connect(master);
    source.onended = () => { voices.delete(source); source.disconnect(); gain.disconnect(); pan.disconnect(); };
    voices.add(source);
    source.start();
  }
  function stop() {
    generation++;
    for (const voice of voices) { try { voice.stop(); } catch {} }
    voices.clear();
  }
  function setVolume(value) {
    if (master) master.gain.setValueAtTime(Math.max(0, Math.min(1, value)), context.currentTime);
  }
  function preview() {
    const current = generation;
    void unlock().then(ready => { if (ready && current === generation) play('magic'); });
  }
  return { unlock, play, stop, setVolume, preview };
}
