# Coffee Tracker

A small installable web app (PWA) for keeping track of the coffees you buy and
dialling in espresso with them.

- **Add a coffee** by tapping **+** and photographing the front and back of the
  bag. The photos are read by a vision model through OpenRouter and the details
  (name, roaster, origin, process, roast date, tasting notes and so on) are
  filled in for you to check.
- **Log brews** for each coffee: beans in, grind size, extraction time, optional
  yield, a 1 to 10 rating and an optional note. A new brew starts from the
  settings of your last one, and the best-rated recipe stays pinned at the top.
- **Your data stays on your phone.** Coffees, brews and photos live in the
  browser's storage (IndexedDB). There are no accounts and no database. Settings
  has an export/import backup.

## Run it

```bash
cp .env.example .env      # add your OpenRouter key
docker compose up -d --build
```

The app is then on <http://localhost:8080>.

Or without compose:

```bash
docker build -t coffee-tracker .
docker run -d --name coffee-tracker -p 8080:80 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -v coffee-tracker-storage:/storage \
  coffee-tracker
```

### HTTPS

Put it behind HTTPS on your server. Browsers only allow installing a PWA and
running its offline support on a secure origin (`localhost` is the one
exception).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | none | Enables reading bag photos. Without it the app works, but you type the details in. |
| `OPENROUTER_MODEL` | `google/gemini-3.5-flash-lite` | Any OpenRouter model that accepts image input. |
| `APP_PASSWORD` | none | If set, each device is asked for it once before the server will read photos. Recommended when the app is reachable from the internet, so nobody else can spend your OpenRouter credit. |
| `PORT` | `80` | Port the server listens on inside the container. |
| `STORAGE_DIR` | `/storage` | Where the optional `config.json` is looked up. |

The same keys can instead be placed in `/storage/config.json`, which is handy
when the host does not let you set environment variables. Environment variables
win when both are present.

```json
{
  "OPENROUTER_API_KEY": "sk-or-...",
  "APP_PASSWORD": "something-long"
}
```

Settings in the app shows whether photo reading is on and which model is used.
If the model id is wrong, adding a coffee shows OpenRouter's error message and
you can still fill the form in by hand.

## Deploying with ONCE

The image follows the ONCE conventions: it serves HTTP on port 80, answers the
health check at `/up`, and keeps its only persistent file in `/storage`. Because
ONCE passes a fixed set of environment variables, use `/storage/config.json` for
the OpenRouter key.

## How it is built

- `server.js` is a dependency-free Node server. It serves `public/` and exposes
  `POST /api/extract`, which forwards one or two photos to OpenRouter and returns
  the extracted fields. The API key never reaches the browser. The endpoint is
  rate limited per IP.
- `public/` is the app: plain HTML, CSS and ES modules, no build step. Photos
  are downscaled on the phone before they are stored or sent.
- `public/sw.js` caches the app shell so it opens offline. Adding a coffee from
  photos needs a connection; everything else works without one.

## Development

```bash
OPENROUTER_API_KEY=sk-or-... npm run dev   # http://localhost:8080
npm test
```

Needs Node 20 or newer. There is nothing to install.

## Backups

Browsers can clear a site's storage, most often on iPhones when a site that has
not been added to the home screen goes unused for a few weeks. Install the app
to the home screen and use **Settings → Export backup** occasionally. Importing
a backup merges it into whatever is already on the device.
