# WardSignal

WardSignal is a browser-only hackathon demonstration for reviewing a synthetic hospital ward queue, exploring patient signal stories, replaying observations, and recording demo alert actions. It is decision-support demonstration software, not a diagnosis or treatment system.

## Run locally

From the project folder:

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal. The interface and all demo interactions run in the browser; no API service, environment variable, Python install, or database is required. Demo changes are saved in this browser's local storage. To restore the seeded starting state, delete the `wardsignal-browser-demo-v1` local-storage item for the site and reload.

## Deploy to Vercel

Import this repository as a Vite project. Vercel uses `npm run build` and publishes the `dist` directory. No API URL or backend environment variables are required. Remove any old `VITE_API_URL` variable from the Vercel project; this frontend no longer uses it. A push to the connected GitHub branch triggers a new deployment.

## Demo scope

- Five fictional Indian patient profiles include stable, rising-trend, stale/missing-data, and open-alert examples.
- Scenario replay adds timestamped synthetic observations and updates the patient overview, charts, freshness labels, prototype estimate, alert state, and audit timeline.
- Alert acknowledgement, reassignment, in-app notifications, and the 90-second simulated backup escalation work locally in the browser.
- Demo state persists in local storage on the current browser/device; it does not synchronize between clinicians or devices.
- The transparent deterministic estimate is not a trained or evaluated clinical model. The sample ECG is for waveform viewing only and is not used by the estimate.

The `backend/` directory contains the earlier optional FastAPI/SQLite prototype; the current Vercel website does not call or deploy it. Do not use this prototype with real patient data.
