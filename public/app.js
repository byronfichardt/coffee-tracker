import { h, icon } from './dom.js';
import * as db from './db.js';
import { fileToJpeg, makeThumb } from './images.js';

const VERSION = '1.0.0';
const PASSWORD_KEY = 'coffee-tracker:app-password';
const CONFIG_KEY = 'coffee-tracker:server-config';

const app = document.getElementById('app');
const cameraInput = document.getElementById('camera-input');
const libraryInput = document.getElementById('library-input');
const importInput = document.getElementById('import-input');

const state = {
  config: { ai: false, model: '', passwordRequired: false },
  draft: null, // the coffee being added: { front, back, phase, fields, error, aiFilled }
};

// What a coffee is made of. `wide` fields take the full row in the form.
const COFFEE_FIELDS = [
  { key: 'name', label: 'Coffee name', wide: true, required: true, placeholder: 'e.g. La Esperanza' },
  { key: 'roaster', label: 'Roaster', wide: true },
  { key: 'origin', label: 'Origin' },
  { key: 'region', label: 'Region' },
  { key: 'process', label: 'Process' },
  { key: 'roastLevel', label: 'Roast' },
  { key: 'variety', label: 'Variety' },
  { key: 'producer', label: 'Producer' },
  { key: 'roastDate', label: 'Roast date', type: 'date' },
  { key: 'weight', label: 'Bag weight' },
  { key: 'altitude', label: 'Altitude', wide: true },
  { key: 'tastingNotes', label: 'Tasting notes', wide: true },
];

/* ---------- small helpers ---------- */

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const num = (value) => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '');

function parseNumber(text) {
  const value = Number(String(text ?? '').trim().replace(',', '.'));
  return String(text ?? '').trim() !== '' && Number.isFinite(value) ? value : null;
}

function dayDiff(iso) {
  const then = new Date(iso);
  const now = new Date();
  const a = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86_400_000);
}

function shortDate(iso) {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function relativeDay(iso) {
  const days = dayDiff(iso);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return shortDate(iso);
}

/** "YYYY-MM-DD" is parsed as local midnight, not UTC. */
const localDate = (ymd) => new Date(`${ymd}T00:00:00`);

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ratingClass = (rating) => `rating r${Math.min(10, Math.max(1, Math.round(rating)))}`;

function ratio(brew) {
  return brew.dose > 0 && brew.yield > 0 ? `1:${(brew.yield / brew.dose).toFixed(1)}` : '';
}

/** Highest rating wins; ties go to the most recent brew. */
function bestBrew(brews) {
  return brews.reduce(
    (best, b) => (!best || b.rating > best.rating || (b.rating === best.rating && b.brewedAt > best.brewedAt) ? b : best),
    null,
  );
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function go(hash, { replace = false } = {}) {
  if (location.hash === hash) return render();
  if (replace) location.replace(hash);
  else location.hash = hash;
}

/* ---------- shared UI pieces ---------- */

function header(title, { back, action } = {}) {
  return h('header', { class: 'bar' },
    back
      ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, icon('back'))
      : h('span', { class: 'bar-mark', 'aria-hidden': 'true' }, icon('bean', 26)),
    h('h1', { class: 'bar-title' }, title),
    action || h('span', { class: 'bar-spacer' }),
  );
}

function fab(label, onclick) {
  return h('button', { class: 'fab', type: 'button', onclick }, icon('plus', 22), h('span', null, label));
}

function field(label, control, { wide = false, hint } = {}) {
  return h('label', { class: `field${wide ? ' wide' : ''}` },
    h('span', { class: 'field-label' }, label),
    control,
    hint && h('span', { class: 'field-hint' }, hint),
  );
}

/** A bottom sheet built on <dialog>. Resolves when it closes. */
function openSheet(title, build) {
  const dialog = h('dialog', { class: 'sheet' });
  const close = () => dialog.close();
  dialog.append(
    h('div', { class: 'sheet-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close')),
    ),
    build(close),
  );
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
  });
}

function confirmSheet(title, message, confirmLabel) {
  let confirmed = false;
  return openSheet(title, (close) => h('div', { class: 'sheet-body' },
    h('p', { class: 'muted' }, message),
    h('div', { class: 'actions' },
      h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmed = true; close(); } }, confirmLabel),
      h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'),
    ),
  )).then(() => confirmed);
}

/* ---------- coffee list ---------- */

async function listView() {
  const [coffees, brews] = await Promise.all([db.listCoffees(), db.allBrews()]);
  const stats = new Map();
  for (const brew of brews) {
    const s = stats.get(brew.coffeeId) || { count: 0, best: 0, last: '' };
    s.count += 1;
    s.best = Math.max(s.best, brew.rating);
    if (brew.brewedAt > s.last) s.last = brew.brewedAt;
    stats.set(brew.coffeeId, s);
  }
  const activity = (c) => stats.get(c.id)?.last || c.createdAt;
  coffees.sort((a, b) => (activity(a) < activity(b) ? 1 : -1));

  const settings = h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': 'Settings' }, icon('settings'));

  const body = coffees.length === 0
    ? h('div', { class: 'empty' },
        h('div', { class: 'empty-mark' }, icon('bean', 44)),
        h('h2', null, 'No coffees yet'),
        h('p', null, 'Add a bag by photographing its front and back. The details are filled in from the photos, then you log each shot you pull.'),
      )
    : h('ul', { class: 'cards' }, coffees.map((coffee) => {
        const s = stats.get(coffee.id);
        const sub = [coffee.roaster, coffee.origin].filter(Boolean).join(' · ');
        return h('li', null,
          h('a', { class: 'card coffee-card', href: `#/coffee/${coffee.id}` },
            coffee.thumb
              ? h('img', { class: 'thumb', src: coffee.thumb, alt: '' })
              : h('span', { class: 'thumb placeholder' }, icon('bean', 28)),
            h('span', { class: 'coffee-card-text' },
              h('span', { class: 'coffee-card-name' }, coffee.name),
              sub && h('span', { class: 'coffee-card-sub' }, sub),
              h('span', { class: 'coffee-card-meta' },
                s ? `${s.count} ${s.count === 1 ? 'brew' : 'brews'} · last ${relativeDay(s.last).toLowerCase()}` : 'No brews yet'),
            ),
            s
              ? h('span', { class: ratingClass(s.best), title: 'Best rating' }, s.best)
              : h('span', { class: 'chev' }, icon('chevron', 20)),
          ),
        );
      }));

  return h('div', { class: 'view' },
    header('Coffees', { action: settings }),
    body,
    fab('Coffee', () => {
      state.draft = newDraft();
      openCamera('front'); // must happen inside the tap, before anything async
      go('#/new');
    }),
  );
}

/* ---------- add a coffee: photos -> read -> check -> save ---------- */

function newDraft() {
  return { front: null, back: null, phase: 'photos', fields: {}, error: null, aiFilled: false };
}

let pendingSide = 'front';

function openCamera(side) {
  pendingSide = side;
  cameraInput.value = '';
  cameraInput.click();
}

async function addPhotos(entries) {
  const draft = (state.draft ??= newDraft());
  for (const [side, file] of entries) {
    try {
      draft[side] = await fileToJpeg(file);
    } catch {
      toast('That photo could not be opened. Try again.');
    }
  }
  if (state.draft !== draft) return;
  if (draft.phase === 'photos' && draft.front && draft.back) return readBag();
  go('#/new');
}

cameraInput.addEventListener('change', () => {
  const file = cameraInput.files[0];
  if (file) addPhotos([[pendingSide, file]]);
});

libraryInput.addEventListener('change', () => {
  const draft = (state.draft ??= newDraft());
  const files = [...libraryInput.files].slice(0, 2);
  const sides = files.length === 2 ? ['front', 'back'] : [draft.front ? 'back' : 'front'];
  if (files.length) addPhotos(files.map((file, i) => [sides[i], file]));
});

async function extract(images) {
  const password = localStorage.getItem(PASSWORD_KEY) || '';
  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(password ? { 'X-App-Password': password } : {}) },
    body: JSON.stringify({ images }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `The server answered ${response.status}.`), { status: response.status });
  }
  return data.coffee || {};
}

function askPassword() {
  let saved = false;
  const input = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  return openSheet('App password', (close) => h('form', {
    class: 'sheet-body',
    onsubmit: (event) => {
      event.preventDefault();
      localStorage.setItem(PASSWORD_KEY, input.value);
      saved = true;
      close();
    },
  },
    h('p', { class: 'muted' }, 'This server asks for a password before it reads photos. It is remembered on this device.'),
    field('Password', input),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Continue')),
  )).then(() => saved);
}

async function readBag() {
  const draft = state.draft;
  if (!draft) return;
  if (!state.config.ai) {
    draft.phase = 'form';
    return go('#/new');
  }
  draft.phase = 'reading';
  draft.error = null;
  go('#/new');
  const images = [draft.front, draft.back].filter(Boolean);
  try {
    let fields;
    try {
      fields = await extract(images);
    } catch (err) {
      if (err.status !== 401 || state.draft !== draft || !(await askPassword())) throw err;
      fields = await extract(images);
    }
    if (state.draft !== draft) return;
    const found = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
    draft.fields = { ...draft.fields, ...found };
    draft.aiFilled = Object.keys(found).length > 0;
    if (!draft.aiFilled) draft.error = 'Nothing readable was found in the photos.';
  } catch (err) {
    if (state.draft !== draft) return;
    draft.error = navigator.onLine ? err.message : 'You are offline, so the photos could not be read.';
  }
  draft.phase = 'form';
  go('#/new');
}

function photoSlot(draft, side, label) {
  const data = draft[side];
  return h('button', { class: `slot${data ? ' filled' : ''}`, type: 'button', onclick: () => openCamera(side) },
    data ? h('img', { src: data, alt: `${label} of the bag` }) : icon('camera', 30),
    h('span', { class: 'slot-label' }, data ? `${label} · retake` : label),
  );
}

function newView() {
  const draft = (state.draft ??= newDraft());
  const cancel = h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Cancel', onclick: () => { state.draft = null; } }, icon('close'));

  if (draft.phase === 'reading') {
    return h('div', { class: 'view' },
      header('New coffee', { action: cancel }),
      h('div', { class: 'reading' },
        h('div', { class: 'reading-photos' },
          [draft.front, draft.back].filter(Boolean).map((src) => h('img', { src, alt: '' })),
        ),
        h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Reading' }),
        h('h2', null, 'Reading the bag…'),
        h('p', { class: 'muted' }, 'This usually takes a few seconds.'),
      ),
    );
  }

  if (draft.phase === 'form') {
    const hasPhotos = draft.front || draft.back;
    let notice = null;
    if (draft.error) {
      notice = h('div', { class: 'notice warn' },
        h('p', null, h('strong', null, 'The photos could not be read. '), draft.error),
        h('p', null, 'Fill it in by hand, or ',
          h('button', { class: 'link', type: 'button', onclick: readBag }, 'try again'), '.'),
      );
    } else if (draft.aiFilled) {
      notice = h('div', { class: 'notice' }, 'Filled in from your photos. Check it over and fix anything that looks off.');
    } else if (hasPhotos && !state.config.ai) {
      notice = h('div', { class: 'notice warn' }, 'Photo reading is not set up on the server, so fill the details in by hand. The photos are still saved with the coffee.');
    }
    return h('div', { class: 'view' },
      header('New coffee', { action: cancel }),
      hasPhotos && h('div', { class: 'form-photos' },
        [draft.front, draft.back].filter(Boolean).map((src) => h('img', { src, alt: '' })),
        h('button', { class: 'link', type: 'button', onclick: () => { draft.phase = 'photos'; render(); } }, 'Change photos'),
      ),
      notice,
      coffeeForm(draft.fields, 'Save coffee', async (fields) => {
        const now = new Date().toISOString();
        const id = uid();
        const cover = draft.front || draft.back;
        const thumb = cover ? await makeThumb(cover).catch(() => '') : '';
        await db.saveCoffee({ id, ...fields, thumb, createdAt: now, updatedAt: now }, { front: draft.front, back: draft.back });
        navigator.storage?.persist?.().catch(() => {});
        state.draft = null;
        go(`#/coffee/${id}`, { replace: true });
      }, (fields) => { draft.fields = fields; }),
    );
  }

  // phase: photos
  const next = !draft.front ? 'front' : !draft.back ? 'back' : null;
  return h('div', { class: 'view' },
    header('New coffee', { action: cancel }),
    h('p', { class: 'lead' }, 'Photograph the bag, front and back. The details are read from the photos.'),
    h('div', { class: 'slots' }, photoSlot(draft, 'front', 'Front'), photoSlot(draft, 'back', 'Back')),
    h('div', { class: 'actions stack' },
      next
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => openCamera(next) },
            icon('camera', 20), `Take ${next} photo`)
        : h('button', { class: 'btn primary', type: 'button', onclick: readBag }, 'Read the bag'),
      draft.front && !draft.back &&
        h('button', { class: 'btn ghost', type: 'button', onclick: readBag }, 'Continue with just the front'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { libraryInput.value = ''; libraryInput.click(); } },
        icon('image', 20), 'Choose from photo library'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { draft.phase = 'form'; render(); } },
        draft.front || draft.back ? 'Skip reading, fill in by hand' : 'Enter by hand instead'),
    ),
  );
}

function coffeeForm(values, submitLabel, onSave, onChange) {
  const inputs = {};
  const read = () => Object.fromEntries(COFFEE_FIELDS.map((f) => [f.key, inputs[f.key].value.trim()]));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  return h('form', {
    class: 'form',
    oninput: () => onChange?.(read()),
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await onSave(read());
      } catch (err) {
        submit.disabled = false;
        toast(`Could not save: ${err.message}`);
      }
    },
  },
    h('div', { class: 'grid' }, COFFEE_FIELDS.map((f) => {
      inputs[f.key] = h('input', {
        type: f.type || 'text',
        name: f.key,
        required: f.required,
        placeholder: f.placeholder,
        autocomplete: 'off',
        autocapitalize: f.type ? null : 'words',
        value: values[f.key] || '',
      });
      return field(f.label, inputs[f.key], { wide: f.wide });
    })),
    h('div', { class: 'actions stack' }, submit),
  );
}

/* ---------- one coffee and its brews ---------- */

async function coffeeView(id) {
  const [coffee, brews, photos] = await Promise.all([db.getCoffee(id), db.listBrews(id), db.getPhotos(id)]);
  if (!coffee) return notFound();
  brews.sort((a, b) => (a.brewedAt < b.brewedAt ? 1 : -1));
  const best = bestBrew(brews);

  const facts = [
    ['Origin', [coffee.origin, coffee.region].filter(Boolean).join(', ')],
    ['Process', coffee.process],
    ['Roast', coffee.roastLevel],
    ['Variety', coffee.variety],
    ['Producer', coffee.producer],
    ['Altitude', coffee.altitude],
    ['Bag', coffee.weight],
  ].filter(([, value]) => value);

  let roasted = null;
  if (coffee.roastDate) {
    const days = dayDiff(localDate(coffee.roastDate));
    const age = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
    roasted = `Roasted ${shortDate(localDate(coffee.roastDate))}${days >= 0 ? ` · ${age}` : ''}`;
  }

  const photoList = ['front', 'back'].filter((side) => photos[side]);
  const hero = photoList.length
    ? h('button', {
        class: 'hero-photos', type: 'button', 'aria-label': 'View photos',
        onclick: () => openSheet('Photos', () => h('div', { class: 'sheet-body photo-viewer' },
          photoList.map((side) => h('img', { src: photos[side], alt: `${side} of the bag` })))),
      }, photoList.map((side) => h('img', { src: photos[side], alt: '' })))
    : null;

  const openBrew = (brew) => brewSheet(coffee, brews, brew).then((changed) => changed && render({ keepScroll: true }));

  return h('div', { class: 'view has-fab' },
    header('', {
      back: '#/',
      action: h('a', { class: 'icon-btn', href: `#/coffee/${id}/edit`, 'aria-label': 'Edit coffee' }, icon('edit')),
    }),
    h('section', { class: 'hero' },
      hero,
      h('div', { class: 'hero-text' },
        coffee.roaster && h('p', { class: 'eyebrow' }, coffee.roaster),
        h('h2', { class: 'hero-name' }, coffee.name),
        coffee.tastingNotes && h('p', { class: 'notes' }, coffee.tastingNotes),
        roasted && h('p', { class: 'muted small' }, roasted),
      ),
    ),
    facts.length > 0 && h('dl', { class: 'facts' },
      facts.map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, value)))),

    best && h('section', { class: 'card best' },
      h('div', { class: 'best-head' },
        h('span', null, brews.length > 1 ? 'Best so far' : 'Your recipe'),
        h('span', { class: ratingClass(best.rating) }, best.rating),
      ),
      h('div', { class: 'recipe' },
        recipeCell('Dose', num(best.dose), 'g'),
        recipeCell('Grind', best.grind, ''),
        recipeCell('Time', num(best.time), 's'),
        recipeCell('Yield', best.yield ? num(best.yield) : '–', best.yield ? 'g' : ''),
      ),
    ),

    h('div', { class: 'section-head' },
      h('h3', null, 'Brews'),
      brews.length > 0 && h('span', { class: 'muted small' }, `${brews.length} logged`)),
    brews.length === 0
      ? h('p', { class: 'empty-line' }, 'No brews yet. Pull a shot and log it with the button below.')
      : h('ul', { class: 'brews' }, brews.map((brew) => h('li', null,
          h('button', { class: 'brew', type: 'button', onclick: () => openBrew(brew) },
            h('span', { class: ratingClass(brew.rating) }, brew.rating),
            h('span', { class: 'brew-text' },
              h('span', { class: 'brew-main' },
                `${num(brew.dose)} g`, brew.yield ? ` → ${num(brew.yield)} g` : '', ` · ${num(brew.time)} s`),
              h('span', { class: 'brew-sub' }, [`Grind ${brew.grind}`, ratio(brew)].filter(Boolean).join(' · ')),
              brew.note && h('span', { class: 'brew-note' }, brew.note),
            ),
            h('span', { class: 'brew-date' }, relativeDay(brew.brewedAt)),
          )))),
    fab('Brew', () => openBrew(null)),
  );
}

function recipeCell(label, value, unit) {
  return h('div', { class: 'recipe-cell' },
    h('span', { class: 'recipe-value' }, value, unit && h('small', null, unit)),
    h('span', { class: 'recipe-label' }, label),
  );
}

/** Add or edit a brew. Resolves true when something was saved or deleted. */
function brewSheet(coffee, brews, existing) {
  const last = brews[0]; // newest first
  const start = existing || {
    dose: last?.dose ?? null, grind: last?.grind ?? '', time: last?.time ?? null, yield: last?.yield ?? null,
    rating: null, note: '', brewedAt: new Date().toISOString(),
  };
  let rating = start.rating;
  let changed = false;

  const stepper = (input, step, { text = false } = {}) => {
    const bump = (direction) => {
      const current = parseNumber(input.value);
      if (current === null && input.value.trim() !== '') return; // non-numeric grind such as "3B"
      // A grind typed with decimals moves in tenths; a whole-number grind moves in whole steps.
      const size = text && /[.,]\d/.test(input.value) ? 0.1 : step;
      const next = Math.max(0, Math.round(((current ?? 0) + direction * size) * 100) / 100);
      input.value = String(next);
    };
    return h('div', { class: 'stepper' },
      h('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => bump(-1) }, icon('minus', 18)),
      input,
      h('button', { type: 'button', 'aria-label': 'Increase', onclick: () => bump(1) }, icon('plus', 18)),
    );
  };
  const number = (value, attrs) => h('input', {
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: value == null ? '' : num(value), ...attrs,
  });

  const dose = number(start.dose, { required: true, placeholder: '18' });
  const grind = h('input', { type: 'text', inputmode: 'decimal', required: true, autocomplete: 'off', placeholder: '12', value: start.grind });
  const time = number(start.time, { required: true, placeholder: '28' });
  const yieldOut = number(start.yield, { placeholder: '36' });
  const note = h('textarea', { rows: '2', placeholder: 'Optional', value: start.note || '' });
  const when = h('input', { type: 'datetime-local', required: true, value: toLocalInput(start.brewedAt) });
  const ratingError = h('p', { class: 'field-error', hidden: true }, 'Pick a rating from 1 to 10.');

  const ratingButtons = Array.from({ length: 10 }, (_, i) => i + 1).map((value) =>
    h('button', {
      class: 'rate', type: 'button', role: 'radio', 'aria-checked': String(rating === value),
      onclick: () => {
        rating = value;
        ratingError.hidden = true;
        ratingButtons.forEach((btn, i) => btn.setAttribute('aria-checked', String(i + 1 === value)));
      },
    }, value));

  return openSheet(existing ? 'Edit brew' : 'New brew', (close) => h('form', {
    class: 'sheet-body',
    onsubmit: async (event) => {
      event.preventDefault();
      if (!rating) {
        ratingError.hidden = false;
        ratingError.scrollIntoView({ block: 'center' });
        return;
      }
      await db.saveBrew({
        id: existing?.id || uid(),
        coffeeId: coffee.id,
        dose: parseNumber(dose.value),
        grind: grind.value.trim(),
        time: parseNumber(time.value),
        yield: parseNumber(yieldOut.value),
        rating,
        note: note.value.trim(),
        brewedAt: new Date(when.value).toISOString(),
      });
      changed = true;
      close();
    },
  },
    h('p', { class: 'muted small sheet-sub' }, coffee.name,
      !existing && last ? ' · starting from your last brew' : ''),
    h('div', { class: 'grid' },
      field('Beans in (g)', stepper(dose, 0.5)),
      field('Grind size', stepper(grind, 1, { text: true })),
      field('Extraction time (s)', stepper(time, 1)),
      field('Yield out (g)', stepper(yieldOut, 1), { hint: 'Optional' }),
    ),
    h('div', { class: 'field wide' },
      h('span', { class: 'field-label', id: 'rating-label' }, 'How was it?'),
      h('div', { class: 'rates', role: 'radiogroup', 'aria-labelledby': 'rating-label' }, ratingButtons),
      h('div', { class: 'rates-scale' }, h('span', null, 'Bad'), h('span', null, 'Great')),
      ratingError,
    ),
    field('Note', note, { wide: true }),
    field('When', when, { wide: true }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save changes' : 'Save brew'),
      existing && h('button', {
        class: 'btn danger-ghost', type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          if (!button.dataset.armed) { // first tap arms, second tap deletes
            button.dataset.armed = 'yes';
            button.lastChild.textContent = 'Tap again to delete';
            return;
          }
          await db.deleteBrew(existing.id);
          changed = true;
          close();
        },
      }, icon('trash', 18), 'Delete'),
    ),
  )).then(() => changed);
}

async function editView(id) {
  const coffee = await db.getCoffee(id);
  if (!coffee) return notFound();
  return h('div', { class: 'view' },
    header('Edit coffee', { back: `#/coffee/${id}` }),
    coffeeForm(coffee, 'Save changes', async (fields) => {
      await db.saveCoffee({ ...coffee, ...fields, updatedAt: new Date().toISOString() });
      go(`#/coffee/${id}`, { replace: true });
    }),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'btn danger-ghost', type: 'button',
        onclick: async () => {
          const yes = await confirmSheet('Delete this coffee?', `"${coffee.name}", its photos and all of its brews will be removed from this device.`, 'Delete coffee');
          if (!yes) return;
          await db.deleteCoffee(id);
          toast('Coffee deleted');
          go('#/', { replace: true });
        },
      }, icon('trash', 18), 'Delete coffee'),
    ),
  );
}

/* ---------- settings ---------- */

async function settingsView() {
  const [coffees, brews] = await Promise.all([db.listCoffees(), db.allBrews()]);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  const exportBackup = async () => {
    const blob = new Blob([JSON.stringify(await db.exportAll())], { type: 'application/json' });
    const link = h('a', { href: URL.createObjectURL(blob), download: `coffee-tracker-${new Date().toISOString().slice(0, 10)}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };

  const password = h('input', {
    type: 'password', autocomplete: 'current-password', placeholder: 'App password',
    value: localStorage.getItem(PASSWORD_KEY) || '',
    onchange: () => {
      if (password.value) localStorage.setItem(PASSWORD_KEY, password.value);
      else localStorage.removeItem(PASSWORD_KEY);
      toast('Password saved on this device');
    },
  });

  return h('div', { class: 'view' },
    header('Settings', { back: '#/' }),

    h('section', { class: 'card setting' },
      h('h3', null, 'Reading bag photos'),
      state.config.ai
        ? h('p', { class: 'muted' }, 'On. Photos are sent to OpenRouter (', h('code', null, state.config.model), ') when you add a coffee.')
        : h('p', { class: 'muted' }, 'Off. Set ', h('code', null, 'OPENROUTER_API_KEY'), ' on the server to have coffees filled in from photos. Until then you can type the details in.'),
      state.config.passwordRequired && field('Password for this server', password),
    ),

    h('section', { class: 'card setting' },
      h('h3', null, 'Your data'),
      h('p', { class: 'muted' },
        `${coffees.length} ${coffees.length === 1 ? 'coffee' : 'coffees'} and ${brews.length} ${brews.length === 1 ? 'brew' : 'brews'}, stored only on this device. `,
        persisted
          ? 'The browser has marked this storage as persistent.'
          : 'Browsers can clear site storage, so export a backup now and then.'),
      h('div', { class: 'actions stack' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, icon('download', 18), 'Export backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => { importInput.value = ''; importInput.click(); } },
          icon('upload', 18), 'Import backup'),
      ),
    ),

    h('p', { class: 'muted small center' }, `Coffee Tracker ${VERSION}`),
  );
}

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  try {
    const counts = await db.importAll(JSON.parse(await file.text()));
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    toast(`Imported ${count(counts.coffees, 'coffee')} and ${count(counts.brews, 'brew')}`);
    render();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'That file is not a Coffee Tracker backup.' : err.message);
  }
});

/* ---------- router ---------- */

function notFound() {
  return h('div', { class: 'view' },
    header('Not found', { back: '#/' }),
    h('p', { class: 'empty-line' }, 'That coffee is not on this device.'),
  );
}

let renderToken = 0;

async function render({ keepScroll = false } = {}) {
  const token = ++renderToken;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let view;
  try {
    if (parts[0] === 'new') view = newView();
    else if (parts[0] === 'settings') view = await settingsView();
    else if (parts[0] === 'coffee' && parts[1]) view = await (parts[2] === 'edit' ? editView(parts[1]) : coffeeView(parts[1]));
    else view = await listView();
  } catch (err) {
    console.error(err);
    view = h('div', { class: 'view' },
      header('Something went wrong', { back: '#/' }),
      h('p', { class: 'empty-line' }, `The app could not open its storage: ${err.message}`),
    );
  }
  if (token !== renderToken) return; // a newer navigation won
  if (parts[0] !== 'new') state.draft = null;
  app.replaceChildren(view);
  if (!keepScroll) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => render());

// The last known server config is kept so the app behaves the same offline.
try {
  Object.assign(state.config, JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'));
} catch { /* ignore a corrupt cache */ }

fetch('/api/config')
  .then((response) => (response.ok ? response.json() : null))
  .then((config) => {
    if (!config) return;
    state.config = config;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    if (location.hash.startsWith('#/settings')) render();
  })
  .catch(() => {});

render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
