from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

import httpx
from browser_use_sdk import AsyncBrowserUse
from pydantic import BaseModel, Field

from .models import AsyncJobAcceptedResponse, ChatAcceptedResponse, ChatRequest, ImagineRequest, SearchRequest
from .schematic_parser import parse_schematic
from .websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

_ALLOWED_EXTENSIONS = (".schem", ".litematic", ".schematic")
_PLANET_MINECRAFT_PROMPT = """Use Planet Minecraft only.

Search for downloadable Minecraft Java schematics matching this query: {query}
Allowed file extensions: .schem, .litematic, .schematic

Workflow:
1. Search Planet Minecraft.
2. Open promising project pages.
3. Find direct schematic downloads.
4. Skip map/world-save zip downloads.
5. Return best candidates sorted by quality.

Return JSON:
{{
  "candidates": [
    {{
      "canonical_url": "<project_url>",
      "filename": "<download_filename>",
      "title": "<project_title>",
      "score": <float>,
      "download_url": "<direct_download_url>"
    }}
  ]
}}
"""


class _SearchCandidate(BaseModel):
    canonical_url: str
    filename: str
    title: str
    score: float = Field(default=0.0)
    download_url: str | None = None


class _SearchCandidates(BaseModel):
    candidates: list[_SearchCandidate] = Field(default_factory=list)


@dataclass(slots=True)
class _DownloadedSchematic:
    path: Path
    title: str
    source_url: str


class DemoPipelines:
    def __init__(
        self,
        *,
        websocket_manager: WebSocketManager,
        browser_use_api_key: str | None,
        browser_use_llm: str,
        browser_use_skill_id: str | None,
        tripo_api_key: str | None,
        chat_submitter: Callable[[ChatRequest], Awaitable[ChatAcceptedResponse]] | None,
    ) -> None:
        self._websocket_manager = websocket_manager
        self._browser_use_api_key = browser_use_api_key or os.getenv("BROWSER_USE_API_KEY")
        self._browser_use_llm = browser_use_llm
        self._browser_use_skill_id = browser_use_skill_id or os.getenv("BROWSER_USE_PLANET_MINECRAFT_SKILL_ID")
        self._tripo_api_key = tripo_api_key or os.getenv("TRIPO_API_KEY")
        self._chat_submitter = chat_submitter
        self._tasks: set[asyncio.Task[None]] = set()

    async def submit_search(self, request: SearchRequest) -> AsyncJobAcceptedResponse:
        job_id = str(uuid4())
        task = asyncio.create_task(
            self._run_search(
                job_id=job_id,
                client_id=request.client_id,
                query=request.query,
            )
        )
        self._track_task(task)
        return AsyncJobAcceptedResponse(job_id=job_id, status="accepted")

    async def submit_imagine(self, request: ImagineRequest) -> AsyncJobAcceptedResponse:
        job_id = str(uuid4())
        task = asyncio.create_task(
            self._run_imagine(
                job_id=job_id,
                client_id=request.client_id,
                prompt=request.prompt,
            )
        )
        self._track_task(task)
        return AsyncJobAcceptedResponse(job_id=job_id, status="accepted")

    def _track_task(self, task: asyncio.Task[None]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._on_task_done)

    def _on_task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        try:
            task.result()
        except Exception:
            logger.exception("Pipeline task failed")

    async def _run_search(self, *, job_id: str, client_id: str, query: str) -> None:
        try:
            await self._emit_status(client_id, "🔎 Searching Planet Minecraft...")
            downloaded = await self._search_and_download(
                query=query,
                status_callback=lambda status: self._emit_status(client_id, status),
            )
            placements = parse_schematic(downloaded.path)
            await self._emit_status(client_id, f"📐 Loaded {len(placements)} blocks into preview")
            await self._websocket_manager.request_tool(
                client_id=client_id,
                tool_name="set_plan",
                params={"placements": placements},
            )
            await self._emit_status(client_id, "✓ Done")
            await self._emit_chat_response(
                client_id=client_id,
                job_id=job_id,
                message=(
                    f"Loaded plan preview from {downloaded.title} "
                    f"({len(placements)} blocks). Walk to position and confirm."
                ),
            )
        except Exception as exc:
            logger.exception("Search pipeline failed for client=%s", client_id)
            await self._emit_status(client_id, f"✗ Search failed: {exc}")
            await self._emit_chat_response(
                client_id=client_id,
                job_id=job_id,
                message=f"Search failed: {exc}",
            )

    async def _run_imagine(self, *, job_id: str, client_id: str, prompt: str) -> None:
        style_prompt = f"{prompt}, minecraft voxel art style, isometric view, blocky"
        if not self._tripo_api_key:
            await self._emit_status(client_id, "🎨 Tripo API unavailable, routing to creative plan fallback...")
            if self._chat_submitter is None:
                await self._emit_chat_response(
                    client_id=client_id,
                    job_id=job_id,
                    message="Tripo is unavailable and chat fallback is not configured.",
                )
                return
            await self._chat_submitter(
                ChatRequest(
                    client_id=client_id,
                    mode="plan",
                    message=(
                        f"Plan and preview a creative detailed build for: {prompt}. "
                        "Use varied materials, depth, layered silhouettes, decorative trim, windows/overhangs, "
                        "and stairs/slabs for detail. Return a build-ready plan with realistic proportions."
                    ),
                )
            )
            return

        await self._emit_status(client_id, "🎨 Generating reference image...")
        await self._emit_status(client_id, "🧊 Converting image to voxel plan...")
        await self._emit_chat_response(
            client_id=client_id,
            job_id=job_id,
            message=(
                "Tripo integration scaffolding is ready, but this environment still needs the concrete Tripo export "
                f"flow configured for prompt: {style_prompt}"
            ),
        )

    async def _search_and_download(
        self,
        *,
        query: str,
        status_callback: Callable[[str], Awaitable[None]],
    ) -> _DownloadedSchematic:
        if not self._browser_use_api_key:
            raise RuntimeError("BROWSER_USE_API_KEY is required for /search")

        browser = AsyncBrowserUse(api_key=self._browser_use_api_key, timeout=300.0)
        try:
            task = browser.run(
                task=_PLANET_MINECRAFT_PROMPT.format(query=query),
                output_schema=_SearchCandidates,
                llm=self._browser_use_llm,
                max_steps=18,
                allowed_domains=["planetminecraft.com", "www.planetminecraft.com"],
                skill_ids=[self._browser_use_skill_id] if self._browser_use_skill_id else None,
            )
            async for _ in task:
                pass
            if task.result is None:
                raise RuntimeError("Browser task did not return a result")

            best_candidate = _best_candidate(task.result.output)
            if best_candidate is None:
                raise RuntimeError("No schematic candidates found")
            await status_callback(f"✅ Found: {best_candidate.title}")
            await status_callback("📥 Downloading schematic...")

            with tempfile.TemporaryDirectory(prefix="browsecraft-search-") as temp_dir:
                downloaded = await _download_candidate(
                    browser=browser,
                    result=task.result,
                    candidate=best_candidate,
                    target_dir=Path(temp_dir),
                )
                persistent = Path(tempfile.gettempdir()) / f"browsecraft-{uuid4()}{downloaded.path.suffix.lower()}"
                persistent.write_bytes(downloaded.path.read_bytes())
                return _DownloadedSchematic(
                    path=persistent,
                    title=downloaded.title,
                    source_url=downloaded.source_url,
                )
        finally:
            await browser.close()

    async def _emit_status(self, client_id: str, status: str) -> None:
        await self._websocket_manager.send_payload(
            client_id,
            {
                "type": "chat.tool_status",
                "payload": {"status": status},
            },
        )

    async def _emit_chat_response(self, *, client_id: str, job_id: str, message: str) -> None:
        await self._websocket_manager.send_payload(
            client_id,
            {
                "type": "chat.response",
                "chat_id": job_id,
                "payload": {"message": message},
            },
        )


def _best_candidate(output: _SearchCandidates | str | None) -> _SearchCandidate | None:
    if output is None or isinstance(output, str):
        return None
    if not output.candidates:
        return None
    sorted_candidates = sorted(output.candidates, key=lambda item: item.score, reverse=True)
    for candidate in sorted_candidates:
        lowered = candidate.filename.lower()
        if lowered.endswith(_ALLOWED_EXTENSIONS):
            return candidate
    return sorted_candidates[0]


async def _download_candidate(
    *,
    browser: AsyncBrowserUse,
    result: Any,
    candidate: _SearchCandidate,
    target_dir: Path,
) -> _DownloadedSchematic:
    target_dir.mkdir(parents=True, exist_ok=True)

    download_url = candidate.download_url
    filename = candidate.filename
    if download_url:
        file_path = target_dir / filename
        async with httpx.AsyncClient(follow_redirects=True, timeout=120.0) as http_client:
            response = await http_client.get(download_url)
            response.raise_for_status()
            file_path.write_bytes(response.content)
        return _DownloadedSchematic(path=file_path, title=candidate.title, source_url=candidate.canonical_url)

    output_files = getattr(result.task, "outputFiles", [])
    if not output_files:
        raise RuntimeError("Candidate did not include a download URL and no output files were produced")
    file_view = output_files[0]
    file_meta = await browser.files.task_output(str(result.task.id), str(file_view.id))
    file_path = target_dir / str(file_meta.fileName)
    async with httpx.AsyncClient(follow_redirects=True, timeout=120.0) as http_client:
        response = await http_client.get(str(file_meta.downloadUrl))
        response.raise_for_status()
        file_path.write_bytes(response.content)
    return _DownloadedSchematic(path=file_path, title=candidate.title, source_url=candidate.canonical_url)
