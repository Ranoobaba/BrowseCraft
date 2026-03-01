# Instructions For Coding Agents Working With This Repo

This is a hackathon project. Production-readiness is unnecessary.

## Run Tests

```bash
cd ~/BrowseCraft/backend && uv run pytest -q
cd ~/BrowseCraft/mod && gradle test
cd ~/BrowseCraft/mod && gradle build
```

## Verify Outputs

The closest thing to a real user test is the in-game `/build-test` command. If you can run `gradle runClientGametest`, check:

```bash
cat ~/BrowseCraft/mod/build/run/clientGameTest/browsecraft/build-test/ghost-state.json | jq '{validation, render_status, render_status_observed}'
find ~/BrowseCraft/mod/build/run/clientGameTest/screenshots -type f | sort | tail -1
```

The screenshot must show ghost block wireframe outlines in front of the player.

## E2E Debug Loop

Unit tests use fakes. The real validation is whether features work in Minecraft.

### API Keys

Set in `backend/.env`:

| Key                                | Required for                             |
| ---------------------------------- | ---------------------------------------- |
| `ANTHROPIC_API_KEY`                | /imagine (vision) + /chat (orchestrator) |
| `GOOGLE_API_KEY`                   | /imagine (Gemini image gen)              |
| `BROWSER_USE_API_KEY`              | /build (Planet Minecraft browsing)       |
| `SUPERMEMORY_API_KEY`              | /chat memory across interactions         |
| `CONVEX_URL` + `CONVEX_ACCESS_KEY` | Session persistence across restarts      |

Optional: `LAMINAR_API_KEY` (tracing, helpful for debugging), `GITHUB_TOKEN`, `CURSEFORGE_API_KEY` (extra schematic sources).

### Start the backend

```bash
cd ~/BrowseCraft/backend
uv run uvicorn browsecraft_backend.app:app --host 127.0.0.1 --port 8080 --log-level info 2>&1 | tee /tmp/browsecraft-backend.log &
curl -s http://127.0.0.1:8080/health
```

### Ghost block rendering (no API keys needed)

```bash
cd ~/BrowseCraft/mod && gradle runClientGameTest
```

Artifacts:

- `mod/build/run/clientGameTest/browsecraft/build-test/ghost-state.json` — must have `"passed": true`
- `mod/build/run/clientGameTest/screenshots/` — must show colored wireframe outlines

### Live feature testing

Start Minecraft: `cd ~/BrowseCraft/mod && gradle runClient`

The mod auto-connects to the backend via WebSocket. Test features with curl:

```bash
# /imagine
curl -s -X POST http://127.0.0.1:8080/v1/imagine \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"small stone tower","client_id":"test"}'

# /imagine modify (requires a prior /imagine for the same client_id)
curl -s -X POST http://127.0.0.1:8080/v1/imagine/modify \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"add a wooden door","client_id":"test"}'

# /chat
curl -s -X POST http://127.0.0.1:8080/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What tools do you have?","client_id":"test"}'

# /build
curl -s -X POST http://127.0.0.1:8080/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{"query":"small oak house","mc_version":"1.21.11","client_id":"test"}'

# Poll job status
curl -s http://127.0.0.1:8080/v1/jobs/<job_id>
```

### What to look at

- Backend logs: `/tmp/browsecraft-backend.log`
- Browser Use dashboard: cloud.browser-use.com (agent recordings for /build)
- Laminar dashboard (if configured): per-call LLM traces with prompts/responses
- Minecraft screenshots: `mod/build/run/client/screenshots/` or `mod/build/run/clientGameTest/screenshots/`
- Any other logs generated

### Fix → retest

Restart the backend after code changes. Always run unit tests first (`uv run pytest -q` / `gradle test`) before retesting live.
