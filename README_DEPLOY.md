# Deployment & Scaling (MVP)

This project is a minimal MVP that supports:
- Real-time (near-real-time) coaching via Gemini Live streaming of ~`1 FPS` JPEG frames (through a backend WebSocket proxy)
- Session logging and analytics (SQLite)
- Optional report generation (PDF) and workout-plan generation (text)

## Run locally with Docker

1. From the repo root (`/Hackathon`):
   - `docker compose up --build`
2. Open: `http://localhost:8080`

Notes:
- SQLite is persisted via `./backend/data` mounted into the container at `/data`.
- For Gemini Live, set `GCP_PROJECT_ID`, `GCP_LOCATION`, and enable ADC credentials in the container environment (see below).

## Gemini Live (Vertex AI) auth

Gemini Live requires server-to-server OAuth with Vertex AI.

You must deploy with a Google Cloud service account that has permissions for Vertex AI and Gemini Live.

Environment variables:
- `GCP_PROJECT_ID`
- `GCP_LOCATION` (default: `us-central1`)
- `GEMINI_LIVE_MODEL` (default: `gemini-live-2.5-flash-native-audio`)

## Cloud Run scaling (WebSockets)

Recommended approach:
- Deploy the backend as a container to Cloud Run.
- Use WebSockets as the transport for live coaching sessions (each user session maps to a single WS connection).

Scaling guidance (starting point):
- Set `max instances` based on your expected simultaneous users.
- Ensure `COACH_EVENTS_PER_MINUTE` is set to control Gemini Live cost (default is `6` in the backend).

## Production storage note (SQLite)

SQLite is used for the MVP and is not ideal for production scaling.
For production, migrate to a managed database (e.g., Cloud SQL Postgres) and keep the same API contract.

## Observability

The backend prints key lifecycle logs:
- WebSocket session start/end
- Coach event calls (with basic rate limiting)

When deployed, these logs should flow into your platform’s logging/monitoring stack (e.g., Cloud Logging).

