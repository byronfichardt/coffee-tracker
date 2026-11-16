// All data lives in IndexedDB on this device.
//   coffees: { id, name, roaster, ..., thumb, createdAt, updatedAt }
//   brews:   { id, coffeeId, dose, grind, time, yield, rating, note, brewedAt }
//   photos:  { id: "<coffeeId>:<side>", coffeeId, side, data }   (full-size JPEG data URLs)

const DB_NAME = 'coffee-tracker';
const DB_VERSION = 1;
const STORES = ['coffees', 'brews', 'photos'];

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('coffees', { keyPath: 'id' });
      db.createObjectStore('brews', { keyPath: 'id' }).createIndex('coffeeId', 'coffeeId');
      db.createObjectStore('photos', { keyPath: 'id' }).createIndex('coffeeId', 'coffeeId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

const result = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
});

async function read(store, fn) {
  const db = await open();
  return result(fn(db.transaction(store).objectStore(store)));
}

async function write(stores, fn) {
  const db = await open();
  const tx = db.transaction(stores, 'readwrite');
  fn(Object.fromEntries(stores.map((name) => [name, tx.objectStore(name)])));
  return finished(tx);
}

export const listCoffees = () => read('coffees', (s) => s.getAll());
export const getCoffee = (id) => read('coffees', (s) => s.get(id));
export const allBrews = () => read('brews', (s) => s.getAll());
export const listBrews = (coffeeId) => read('brews', (s) => s.index('coffeeId').getAll(coffeeId));

export async function getPhotos(coffeeId) {
  const rows = await read('photos', (s) => s.index('coffeeId').getAll(coffeeId));
  return Object.fromEntries(rows.map((row) => [row.side, row.data]));
}

/** Saves a coffee. `photos` ({ front, back }) is only written when given. */
export function saveCoffee(coffee, photos) {
  return write(['coffees', 'photos'], ({ coffees, photos: store }) => {
    coffees.put(coffee);
    for (const [side, data] of Object.entries(photos || {})) {
      if (data) store.put({ id: `${coffee.id}:${side}`, coffeeId: coffee.id, side, data });
    }
  });
}

export function deleteCoffee(id) {
  return write(STORES, ({ coffees, brews, photos }) => {
    coffees.delete(id);
    for (const store of [brews, photos]) {
      store.index('coffeeId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
  });
}

export const saveBrew = (brew) => write(['brews'], ({ brews }) => brews.put(brew));
export const deleteBrew = (id) => write(['brews'], ({ brews }) => brews.delete(id));

export async function exportAll() {
  const [coffees, brews, photos] = await Promise.all(STORES.map((name) => read(name, (s) => s.getAll())));
  return { app: 'coffee-tracker', version: 1, exportedAt: new Date().toISOString(), coffees, brews, photos };
}

/** Merges a backup into this device: records with the same id are replaced. */
export async function importAll(backup) {
  if (backup?.app !== 'coffee-tracker' || !Array.isArray(backup.coffees) || !Array.isArray(backup.brews)) {
    throw new Error('That file is not a Coffee Tracker backup.');
  }
  const ok = (row) => row && typeof row === 'object' && typeof row.id === 'string';
  const coffeeRows = backup.coffees.filter((row) => ok(row) && typeof row.name === 'string');
  const brewRows = backup.brews.filter((row) => ok(row) && typeof row.coffeeId === 'string');
  const photoRows = (backup.photos || []).filter(
    (row) => ok(row) && typeof row.coffeeId === 'string' && /^data:image\//.test(row.data),
  );
  await write(STORES, ({ coffees, brews, photos }) => {
    coffeeRows.forEach((row) => coffees.put(row));
    brewRows.forEach((row) => brews.put(row));
    photoRows.forEach((row) => photos.put(row));
  });
  return { coffees: coffeeRows.length, brews: brewRows.length };
}
