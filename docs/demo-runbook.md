# Demo Runbook

## Goal

Record a backup end-to-end demo after API keys are configured.

## Preflight

1. Fill `backend/.env` with valid keys:
   - `GOOGLE_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `LAMINAR_API_KEY` (optional but recommended)
   - `CONVEX_URL`, `CONVEX_ACCESS_KEY` (optional)
   - `SUPERMEMORY_API_KEY` (optional)
2. Run test gates:
   - `cd ~/BrowseCraft/backend && uv run pytest -q`
   - `cd ~/BrowseCraft/mod && gradle test`
3. Start backend:
   - `cd ~/BrowseCraft/backend && uv run browsecraft-backend`
4. Build/install mod jar:
   - `cd ~/BrowseCraft/mod && gradle build`
   - Copy `mod/build/libs/browsecraft-0.1.0.jar` into Minecraft `mods/`.

## Suggested Demo Flow

1. `/build-test` fallback first.
2. `/build small starter house`.
3. `/imagine dragon statue`.
4. `/chat rotate it`.
5. `/chat make it birch instead of oak`.
6. `/materials`.
7. `/blueprints save demo-1`.
8. `/session new`, then `/chat what did we build?`.

## Recording Notes

- Run the full flow 2-3 times before final recording.
- Keep backend logs visible for credibility during judging.
- If an external API is slow, continue with `/build-test` + `/build` path and explain fallback.
