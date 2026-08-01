<img width="398" height="648" alt="Снимок экрана — 2026-08-01 в 23 33 28" src="https://github.com/user-attachments/assets/a35d718a-8a4d-4aaa-8590-a3832e658cd9" />
<img width="402" height="647" alt="Снимок экрана — 2026-08-01 в 23 33 04" src="https://github.com/user-attachments/assets/6234c200-9682-40a9-a5f8-f7cf7b796760" />


# Legal Services Platform (Telegram)

A Telegram-native legal services platform: clients chat with an AI legal assistant or a real lawyer, while a staff layer (owner / manager / lawyer) runs the operation through role-specific panels — all on one FastAPI backend with real-time chat.

![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![aiogram](https://img.shields.io/badge/aiogram-3.x-26A5E4?style=flat-square&logo=telegram&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![WebSockets](https://img.shields.io/badge/WebSockets-realtime%20chat-black?style=flat-square)
![GigaChat](https://img.shields.io/badge/AI-Sber%20GigaChat-1e3a8a?style=flat-square)

## What it is

Clients open the bot's Mini App and either talk to an AI legal assistant (Sber GigaChat) or get matched into a live chat with a lawyer. Every conversation is also visible to the operations side through purpose-built panels:

- **Client webapp** — chat with the AI assistant or an assigned lawyer, view chat history, send attachments.
- **Lawyer panel** — see chats assigned to them, plus an unclaimed pool (first reply auto-claims the case).
- **Manager panel** — oversight of the chats under their group.
- **Owner panel** — full administrative control: staff management, broadcasts, required-channel gating (bot can require users to join specific channels before using it), a direct support channel to the client, live stats.

A single account can hold a login for the client side and, separately, staff can log into their panels with a login+password unrelated to their Telegram identity — one Telegram account can even hold multiple client logins.

## Architecture

```
Telegram client
   ├─ Bot (aiogram, /start, /owner, /manager, /lawyer)
   └─ 4 Mini Apps (client / lawyer / manager / owner)
                │
                ▼
        FastAPI (async) ──► PostgreSQL
                │
        WebSocket chat (per-role connection pools)
                │
        GigaChat (AI legal assistant)
```

## Security

- **Login+password auth**, independent of Telegram identity — passwords hashed with PBKDF2-SHA256 (260k iterations), constant-time comparison.
- **Rate-limited login** — 5 attempts per 60 seconds per login, blocking brute-force guessing.
- **Role-based access control** on every staff endpoint (owner / manager / lawyer), enforced as a FastAPI dependency, not left to the frontend.
- **Object-level authorization on chats**, not just "logged in" — access rules differ by chat type: the support channel is owner-only, group chats are visible to their assigned manager and lawyer, and lawyer chats are visible to the assigned lawyer or, while unclaimed, to any lawyer.
- **Authenticated WebSockets** — both the client and staff real-time chat connections resolve and verify the session token before the connection is accepted, not after.
- File upload/download require a valid session (client or staff).

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Python 3.12, FastAPI, async SQLAlchemy 2.0, asyncpg, Alembic |
| Bot | aiogram 3.x |
| Real-time | Native WebSockets, per-role connection pools |
| AI | Sber GigaChat |
| Database | PostgreSQL |
| Frontend | Vanilla HTML/CSS/JS, one Mini App per role |
| Deploy | Docker; Railway or self-hosted (Caddy + docker-compose included) |

## Project structure

```
app/
├── api/
│   ├── routes/        # auth, users, chats, messages, files, ai, ws,
│   │                   staff_auth, owner, manager, lawyer
│   ├── security.py     # password hashing, session tokens, RBAC + object-level auth
│   ├── websocket_manager.py
│   └── server.py
├── bot/                 # aiogram handlers (/start, staff entry points)
├── db/                  # SQLAlchemy models, session, CRUD helpers
└── services/             # GigaChat client, broadcast sending, subscription gating
frontend/
├── webapp/               # client Mini App
├── lawyer/ manager/ owner/  # staff panels
alembic/                  # DB migrations
deploy/                   # self-hosted deploy (Caddy + docker-compose)
```

## Running locally

```bash
python -m venv venv
source venv/bin/activate        # venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env            # fill in BOT_TOKEN, DATABASE_URL, GIGACHAT_AUTH_KEY
alembic upgrade head
python run.py
```

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Bot token from @BotFather |
| `DATABASE_URL` | PostgreSQL connection string |
| `GIGACHAT_AUTH_KEY` | Sber GigaChat authorization key |
| `OWNER_BOOTSTRAP_LOGIN` / `OWNER_BOOTSTRAP_PASSWORD` | Creates the first owner account on startup if none exists |
| `WEBAPP_URL` | Public URL the bot points its Mini Apps at |

## Deploying

Two supported paths, both in this repo: Railway (`railway.toml`, `Procfile`) for zero-ops hosting, or a self-hosted box via `deploy/docker-compose.yml` behind Caddy (`deploy/Caddyfile.snippet`) for full control over data residency — relevant for a platform handling client legal documents.
