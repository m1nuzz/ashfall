const cues = Object.freeze({
  fireball: { files: ['fireball-01.ogg', 'fireball-02.ogg'], level: 0.82, gap: 0.065, limit: 5 },
  homing: { files: ['ember-whoosh.ogg'], level: 0.58, gap: 0.09, limit: 4 },
  lightning: { files: ['lightning-01.ogg', 'lightning-02.ogg'], level: 0.62, gap: 0.12, limit: 3 },
  meteor: { files: ['meteor-rumble.ogg'], level: 0.68, gap: 0.18, limit: 2 },
  hit: { files: ['hit.ogg'], level: 0.48, gap: 0.12, limit: 4 },
  blink: { files: ['ember-whoosh.ogg'], level: 0.42, gap: 0.12, limit: 2 },
  shield: { files: ['ember-whoosh.ogg'], level: 0.34, gap: 0.18, limit: 2 },
  ui: { files: ['ui.ogg'], level: 0.2, gap: 0.07, limit: 2 },
  victory: { files: ['round-end.ogg'], level: 0.32, gap: 0.8, limit: 1 },
});
const files = [...new Set(Object.values(cues).flatMap(cue => cue.files))];
const clamp = (value, min, max, fallback = min) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function createAudio(getVolume, report = () => {}) {
  let context = null;
  let bus = null;
  let master = null;
  let loading = null;
  let generation = 0;
  let explicitVolume = null;
  let announced = false;
  const buffers = new Map();
  const voices = new Set();
  const lastPlayed = new Map();
  const variants = new Map();
  const volume = () => clamp(explicitVolume ?? getVolume(), 0, 1);
  function notify(message) {
    try { report(message); } catch {}
  }
  function updateVolume() {
    if (!master) return;
    master.gain.setTargetAtTime(volume(), context.currentTime, 0.015);
  }
  async function unlock() {
    try {
      if (!context) {
        const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        const nextContext = new AudioContextClass();
        try {
          const nextBus = nextContext.createGain();
          const compressor = nextContext.createDynamicsCompressor();
          compressor.threshold.value = -16;
          compressor.knee.value = 12;
          compressor.ratio.value = 4;
          compressor.attack.value = 0.003;
          compressor.release.value = 0.18;
          const limiter = nextContext.createDynamicsCompressor();
          limiter.threshold.value = -4;
          limiter.knee.value = 0;
          limiter.ratio.value = 20;
          limiter.attack.value = 0.001;
          limiter.release.value = 0.08;
          const ceiling = nextContext.createWaveShaper();
          ceiling.curve = Float32Array.from({ length: 4097 }, (_, i) => clamp(i / 2048 - 1, -0.89, 0.89));
          ceiling.oversample = 'none';
          const nextMaster = nextContext.createGain();
          nextMaster.gain.value = volume();
          nextBus.connect(compressor).connect(limiter).connect(ceiling).connect(nextMaster).connect(nextContext.destination);
          context = nextContext;
          bus = nextBus;
          master = nextMaster;
        } catch (error) {
          void nextContext.close().catch(() => {});
          throw error;
        }
      }
      updateVolume();
      if (context.state === 'suspended' || context.state === 'interrupted') await context.resume();
      if (!loading) {
        loading = Promise.all(files.filter(file => !buffers.has(file)).map(async file => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            const response = await fetch('/assets/audio/' + file, { signal: controller.signal });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const buffer = await context.decodeAudioData(await response.arrayBuffer());
            if (!buffer.length || !Number.isFinite(buffer.duration)) throw new Error('Invalid audio');
            buffers.set(file, buffer);
          } catch {
            notify('Не удалось загрузить звук: ' + file);
          } finally {
            clearTimeout(timeout);
          }
        })).finally(() => { loading = null; });
      }
      await loading;
      if (!announced && buffers.size === files.length) {
        announced = true;
        notify('Звуки загружены: огонь — spookymodem / AntumDeluge; гром — InspectorJ (www.jshaw.co.uk); CC BY 3.0 / CC0. Обработанные записи; лицензии и источники — /assets/credits.json.');
      }
      return context.state === 'running' && buffers.size > 0;
    } catch {
      notify('Звук недоступен в этом браузере.');
      return false;
    }
  }
  function play(name, options = {}) {
    const cue = Object.hasOwn(cues, name) ? cues[name] : null;
    if (!cue || !context || context.state !== 'running' || volume() === 0) return;
    const attenuation = clamp(options?.gain ?? 1, 0, 1, 1);
    if (attenuation === 0) return;
    const now = context.currentTime;
    if (now - (lastPlayed.get(name) ?? -Infinity) < cue.gap || voices.size >= 20) return;
    if ([...voices].filter(voice => voice.name === name).length >= cue.limit) return;
    const available = cue.files.filter(file => buffers.has(file));
    if (!available.length) return;
    const index = (variants.get(name) ?? 0) % available.length;
    const buffer = buffers.get(available[index]);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const pan = context.createStereoPanner();
    const voice = { source, gain, name };
    source.buffer = buffer;
    source.playbackRate.value = 1;
    const level = cue.level * attenuation;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + Math.min(0.003, buffer.duration / 4));
    gain.gain.setValueAtTime(level, now + Math.max(0.003, buffer.duration - 0.018));
    gain.gain.linearRampToValueAtTime(0, now + buffer.duration);
    pan.pan.value = clamp(options?.pan ?? 0, -1, 1, 0);
    source.connect(gain).connect(pan).connect(bus);
    source.onended = () => {
      voices.delete(voice);
      source.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    updateVolume();
    voices.add(voice);
    source.start(now);
    lastPlayed.set(name, now);
    variants.set(name, index + 1);
  }
  function stop() {
    generation++;
    lastPlayed.clear();
    for (const { source, gain } of voices) {
      try {
        const now = context.currentTime;
        gain.gain.cancelAndHoldAtTime(now);
        gain.gain.linearRampToValueAtTime(0, now + 0.012);
        source.stop(now + 0.015);
      } catch {
        try { source.stop(); } catch {}
      }
    }
    voices.clear();
  }
  function setVolume(value) {
    explicitVolume = clamp(value, 0, 1);
    updateVolume();
  }
  function preview(name = 'fireball') {
    const current = generation;
    return unlock().then(ready => {
      if (ready && current === generation) play(Object.hasOwn(cues, name) ? name : 'fireball');
    });
  }
  return { unlock, play, stop, setVolume, preview };
}
