export const defaults = Object.freeze({ sensitivity: 1, fov: 75, volume: 0.65, invertY: false, quality: 'high' });
const storageKey = 'ashfall.settings.v2';
export const CS2_RADIANS_PER_COUNT = 0.022 * Math.PI / 180;
export function mouseRadians(counts, sensitivity) {
  return counts * sensitivity * CS2_RADIANS_PER_COUNT;
}
export function normalizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const range = (key, min, max) => typeof input[key] === 'number' && Number.isFinite(input[key]) ? Math.min(max, Math.max(min, input[key])) : defaults[key];
  return { sensitivity: range('sensitivity', 0.01, 20), fov: range('fov', 60, 110), volume: range('volume', 0, 1), invertY: input.invertY === true, quality: input.quality === 'low' ? 'low' : 'high' };
}
export function loadSettings() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return normalizeSettings(JSON.parse(stored));
    const previous = normalizeSettings(JSON.parse(localStorage.getItem('ashfall.settings.v1')));
    previous.sensitivity = defaults.sensitivity;
    return previous;
  }
  catch { return { ...defaults }; }
}
export function mountSettings(onChange) {
  const settings = loadSettings();
  const fields = { sensitivity: 'sensitivity', fov: 'fov', volume: 'volume', invertY: 'invert-y', quality: 'quality' };
  function sync(save = false) {
    for (const [key, id] of Object.entries(fields)) {
      const field = document.getElementById(id);
      if (field.type === 'checkbox') field.checked = settings[key];
      else field.value = String(settings[key]);
    }
    document.getElementById('sensitivity-value').textContent = settings.sensitivity.toFixed(3) + ' CS2';
    document.getElementById('sensitivity-number').value = String(settings.sensitivity);
    document.getElementById('fov-value').textContent = settings.fov + '°';
    document.getElementById('volume-value').textContent = Math.round(settings.volume * 100) + '%';
    if (save) {
      try { localStorage.setItem(storageKey, JSON.stringify(settings)); }
      catch { document.getElementById('settings-status').textContent = 'Хранилище недоступно: настройки действуют до закрытия страницы.'; }
    }
    onChange(settings);
  }
  for (const [key, id] of Object.entries(fields)) {
    document.getElementById(id).addEventListener('input', event => {
      settings[key] = key === 'invertY' ? event.target.checked : key === 'quality' ? event.target.value : Number(event.target.value);
      Object.assign(settings, normalizeSettings(settings));
      sync(true);
    });
  }
  document.getElementById('sensitivity-number').addEventListener('change', event => {
    settings.sensitivity = normalizeSettings({ ...settings, sensitivity: Number(event.target.value) }).sensitivity;
    sync(true);
  });
  document.getElementById('settings-reset').addEventListener('click', () => { Object.assign(settings, defaults); sync(true); });
  for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => { document.getElementById(button.dataset.open).hidden = false; });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { document.getElementById(button.dataset.close).hidden = true; });
  sync();
  return settings;
}
