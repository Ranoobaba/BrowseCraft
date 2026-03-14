# Demo Runbook

## Goal

Record an end-to-end BrowseCraft demo on the new voxel.exec stack.

## Preflight

1. Fill `backend/.env` with:
   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_CHAT_MODEL` (optional override)
   - `CONVEX_URL`, `CONVEX_ACCESS_KEY` (optional)
2. Run the gates:
   - `cd ~/BrowseCraft && pnpm --filter @browsecraft/sim test`
   - `cd ~/BrowseCraft && pnpm --filter @browsecraft/backend test`
   - `cd ~/BrowseCraft/mod && gradle test`
3. Start the backend:
   - `cd ~/BrowseCraft && pnpm --filter @browsecraft/backend dev`
4. Build and run the mod:
   - `cd ~/BrowseCraft/mod && gradle build`
   - `cd ~/BrowseCraft/mod && gradle runClient`

## Suggested Demo Flow

1. `/session new`
2. `/chat build a small stone house next to me`
3. `/chat add windows and a centered doorway`
4. `/chat replace the roof with oak planks`
5. `/session list`

## Recording Notes

- Keep backend logs visible.
- Call out that the mod sends a local voxel snapshot, the server executes JavaScript once, and the client applies the resulting block diff.
- Avoid mentioning deleted commands such as `/search`, `/imagine`, blueprints, or overlay previews.
