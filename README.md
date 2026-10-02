# WardSignal

WardSignal is a local hackathon MVP for reviewing a synthetic hospital ward queue, exploring patient signal stories and recording demo alert actions. It is decision-support demonstration software, not a diagnosis or treatment system.

## Run locally (Windows PowerShell)

From the project folder, create the Python environment and install the backend requirements:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Start the API in one terminal:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
```

In another terminal, install and start the frontend:

```powershell
npm install
npm run dev
```

Open the Vite URL printed by the frontend (normally `http://localhost:5173`). The FastAPI service seeds `backend/wardsignal.db` with fictional profiles the first time it starts. Set `WARDSIGNAL_DB` to use a different SQLite file.

## Deploy the frontend to Vercel

The Vite frontend is configured for Vercel in `vercel.json` (build: `npm run build`, output: `dist`, with SPA routing for the patient profile view). Import this repository into Vercel and deploy from the project root.

Set `VITE_API_URL` in the Vercel project's Environment Variables to the deployed FastAPI origin plus `/api`, for example `https://wardsignal-api.example.com/api`. The variable is embedded at build time, so redeploy after changing it. Local development defaults to `/api` and Vite proxies that path to `http://127.0.0.1:8000`.

Set `WARDSIGNAL_CORS_ORIGINS` on the FastAPI host to the exact Vercel site origin(s), comma-separated (for example, `https://wardsignal.example.com,https://wardsignal-preview.vercel.app`).

**Persistence limitation:** this MVP's backend uses a local SQLite file. Vercel's function filesystem is not durable across invocations, so deploying this API unchanged on Vercel can reset or fragment demo state. For a persistent hosted demo, keep the frontend on Vercel and host FastAPI with durable storage, or migrate the backend database to managed Postgres before deploying the API. Do not use the prototype with real patient data.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Tests cover patient/encounter validation, numeric/missing observation validation, replay updates, one open alert per episode, acknowledgement, reassignment, and the 90-second backup escalation.

## Functional demo scope

- Five synthetic patient and encounter profiles, with a stable, rising review trend, stale data, and an open unacknowledged alert represented in the seeded ward.
- Replay actions add timestamped observations or explicit missing samples. The prototype estimate applies transparent threshold rules to recorded measurements only.
- Alert creation, delivery, updates, acknowledgement, reassignment, resolution, and escalation are stored in the SQLite audit history.
- Notifications are in-app and synthetic. Simulated on-duty and backup clinicians are seeded in the API.
- Sample ECG is illustrative waveform data for viewing only and is not an input to the prototype estimate.

There is no trained/evaluated clinical model, external EHR connection, real patient data, or clinical validation in this MVP.
