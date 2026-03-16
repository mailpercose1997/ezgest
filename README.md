# ezgest

EzGest è una mini web-app (frontend statico) + API (Cloudflare Worker) per gestione prodotti/cassa e reportistica.

## Struttura

- `frontend/`: UI statica (HTML/CSS/JS) + PWA (`sw.js`, `manifest.json`)
- `backend/`: Cloudflare Worker (`wrangler.toml`) + MongoDB

## Requisiti

- Node.js (consigliato: LTS)
- npm
- Account/DB MongoDB (Atlas o self-hosted)
- Wrangler (installato via devDependency nel backend)

## Avvio rapido (dev)

Da root:

```bash
npm run dev
```

Avvia insieme:
- API Worker (Wrangler) su `http://127.0.0.1:8787`
- Frontend statico su `http://127.0.0.1:5173`

## Setup backend (API)

1) Installa dipendenze:

```bash
cd backend
npm install
```

2) Crea le variabili locali:

- Copia `backend/.dev.vars.example` in `backend/.dev.vars`
- Imposta almeno:
  - `MONGODB_URI`
  - `JWT_SECRET`
  - (opzionale) `ALLOWED_ORIGIN`
  - (opzionale) `DB_NAME` (default: `EzGest`)

3) Avvia in locale:

```bash
cd backend
npm run dev
```

Wrangler espone l’API in locale su `http://localhost:8787`.

## Setup frontend (UI)

Il frontend è statico, senza build step.

- Puoi aprire `frontend/index.html` direttamente (alcune funzionalità PWA possono richiedere un server HTTP).
- Consigliato: servire la cartella `frontend/` con un server statico (qualunque va bene).

Esempio (dev server semplice):

```bash
cd frontend
npm run dev
```

Poi apri `http://127.0.0.1:5173`.

Il frontend chiama l’API così:

- **in locale**: `http://localhost:8787/api`
- **in produzione**: `/api` (stesso dominio oppure proxy)

## Deploy (Cloudflare Worker)

Da `backend/`:

```bash
npm run deploy
```

Poi configura i secrets/vars su Cloudflare (es. `wrangler secret put JWT_SECRET`, `wrangler secret put MONGODB_URI`) oppure via dashboard.

## Note importanti

- La rotta reportistica è `GET /api/reports?companyId=...&from=YYYY-MM-DD&to=YYYY-MM-DD&category=...&product=...`
- `companyId` viene verificato lato backend: l’utente deve appartenere a quell’azienda.

## Sicurezza (rate limiting)

In produzione il rate limiting su `POST /api/login` e `POST /api/register` è gestito da un **Durable Object** (`RATE_LIMITER`) per essere consistente tra istanze.