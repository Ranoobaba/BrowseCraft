from __future__ import annotations

import argparse
import asyncio
import json
import uuid

import httpx
import websockets


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BrowseCraft simulator client")
    parser.add_argument("query", help="build query")
    parser.add_argument("--mc-version", default="1.21.11")
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--client-id", default=None)
    return parser


async def run_simulation(query: str, mc_version: str, base_url: str, client_id: str) -> None:
    ws_url = f"{base_url.replace('http://', 'ws://').replace('https://', 'wss://')}/v1/ws/{client_id}"

    async with websockets.connect(ws_url) as websocket:
        async with httpx.AsyncClient(base_url=base_url) as client:
            response = await client.post(
                "/v1/jobs",
                json={"query": query, "mc_version": mc_version, "client_id": client_id},
            )
            response.raise_for_status()
            job_id = response.json()["job_id"]
            print(f"created job {job_id}")

        async for raw_message in websocket:
            event = json.loads(raw_message)
            if event.get("job_id") != job_id:
                continue

            event_type = event.get("type")
            payload = event.get("payload", {})

            if event_type == "job.status":
                print(f"status: {payload.get('stage')} - {payload.get('message')}")
                continue

            if event_type == "job.error":
                print(f"error: {payload.get('code')} - {payload.get('message')}")
                return

            if event_type == "job.ready":
                total_blocks = payload["plan"]["total_blocks"]
                print(f"ready: plan has {total_blocks} blocks")
                for index in range(1, total_blocks + 1):
                    if index == 1 or index == total_blocks or index % max(1, total_blocks // 10) == 0:
                        print(f"placing {index}/{total_blocks}")
                    await asyncio.sleep(0.01)
                print("simulation complete")
                return


def main() -> None:
    args = build_parser().parse_args()
    client_id = args.client_id or str(uuid.uuid4())
    asyncio.run(run_simulation(args.query, args.mc_version, args.base_url, client_id))


if __name__ == "__main__":
    main()
