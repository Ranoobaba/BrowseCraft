from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from browser_use_sdk import AsyncBrowserUse
from pydantic import BaseModel, Field

from .models import AsyncJobAcceptedResponse, ChatAcceptedResponse, ChatRequest, ImagineRequest, SearchRequest
from .schematic_parser import parse_schematic
from .websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

_ALLOWED_EXTENSIONS = (".schem", ".litematic", ".schematic")
_TRIPO_API_BASE_URL = "https://api.tripo3d.ai/v2/openapi"
_TRIPO_POLL_INTERVAL_SECONDS = 4
_TRIPO_POLL_TIMEOUT_SECONDS = 120
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
        tripo_error: Exception | None = None
        if self._tripo_api_key:
            try:
                await self._emit_status(client_id, "🧊 Generating 3D model...")
                placements = await self._generate_tripo_plan_placements(
                    prompt=prompt,
                    status_callback=lambda status: self._emit_status(client_id, status),
                )
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
                    message=f"Loaded plan preview for '{prompt}' ({len(placements)} blocks).",
                )
                return
            except Exception as exc:
                tripo_error = exc
                logger.exception("Tripo imagine pipeline failed for client=%s", client_id)

        if self._chat_submitter is not None:
            if self._tripo_api_key is None:
                await self._emit_status(client_id, "🎨 Tripo API unavailable, routing to creative plan fallback...")
            elif tripo_error is not None:
                await self._emit_status(client_id, "🎨 Tripo failed, routing to creative plan fallback...")
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

        if tripo_error is None:
            message = "Tripo is unavailable and chat fallback is not configured."
        else:
            message = f"Tripo pipeline failed and chat fallback is not configured: {tripo_error}"
        await self._emit_chat_response(client_id=client_id, job_id=job_id, message=message)

    async def _generate_tripo_plan_placements(
        self,
        *,
        prompt: str,
        status_callback: Callable[[str], Awaitable[None]],
    ) -> list[dict[str, Any]]:
        if self._tripo_api_key is None:
            raise RuntimeError("TRIPO_API_KEY is required for Tripo generation")

        headers = {
            "Authorization": f"Bearer {self._tripo_api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=120.0) as http_client:
            text_task_payload = await self._create_tripo_task(
                http_client=http_client,
                headers=headers,
                payload={
                    "type": "text_to_model",
                    "prompt": f"{prompt}, minecraft voxel blocky style",
                },
            )
            text_task_id = _extract_tripo_task_id(text_task_payload)
            await status_callback("⏳ Processing (may take 30-60s)...")
            await self._poll_tripo_task(http_client=http_client, headers=headers, task_id=text_task_id)

            await status_callback("📦 Converting to schematic...")
            convert_task_payload = await self._create_tripo_task(
                http_client=http_client,
                headers=headers,
                payload={
                    "type": "convert_model",
                    "original_model_task_id": text_task_id,
                    "format": "schematic",
                    "minecraft_version": "1_21",
                },
            )
            convert_task_id = _extract_tripo_task_id(convert_task_payload)
            completed_conversion = await self._poll_tripo_task(
                http_client=http_client,
                headers=headers,
                task_id=convert_task_id,
            )

            download_url = _extract_tripo_download_url(completed_conversion)
            schematic_path = await _download_tripo_schematic(http_client=http_client, download_url=download_url)
            return parse_schematic(schematic_path)

    async def _create_tripo_task(
        self,
        *,
        http_client: httpx.AsyncClient,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        response = await http_client.post(f"{_TRIPO_API_BASE_URL}/task", headers=headers, json=payload)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise RuntimeError("Tripo task creation returned non-object JSON")
        return body

    async def _poll_tripo_task(
        self,
        *,
        http_client: httpx.AsyncClient,
        headers: dict[str, str],
        task_id: str,
    ) -> dict[str, Any]:
        deadline = datetime.now(UTC) + timedelta(seconds=_TRIPO_POLL_TIMEOUT_SECONDS)
        while True:
            response = await http_client.get(f"{_TRIPO_API_BASE_URL}/task/{task_id}", headers=headers)
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict):
                raise RuntimeError("Tripo task polling returned non-object JSON")
            status = _extract_tripo_status(body)
            if status == "success":
                return body
            if status in {"failed", "failure", "error", "cancelled", "canceled"}:
                raise RuntimeError(f"Tripo task {task_id} failed with status={status}")
            if datetime.now(UTC) >= deadline:
                raise TimeoutError(f"Timed out waiting for Tripo task {task_id} after {_TRIPO_POLL_TIMEOUT_SECONDS}s")
            await asyncio.sleep(_TRIPO_POLL_INTERVAL_SECONDS)

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


def _extract_tripo_task_id(payload: dict[str, Any]) -> str:
    direct = payload.get("task_id")
    if isinstance(direct, str) and direct:
        return direct
    nested = payload.get("data")
    if isinstance(nested, dict):
        nested_task_id = nested.get("task_id")
        if isinstance(nested_task_id, str) and nested_task_id:
            return nested_task_id
    raise RuntimeError(f"Tripo task creation response missing task_id: {payload}")


def _extract_tripo_status(payload: dict[str, Any]) -> str:
    status = payload.get("status")
    if isinstance(status, str) and status:
        return status.lower()
    nested = payload.get("data")
    if isinstance(nested, dict):
        nested_status = nested.get("status")
        if isinstance(nested_status, str) and nested_status:
            return nested_status.lower()
    raise RuntimeError(f"Tripo task polling response missing status: {payload}")


def _extract_tripo_download_url(payload: dict[str, Any]) -> str:
    candidates = (
        ("model",),
        ("data", "model"),
        ("output", "model"),
        ("data", "output", "model"),
        ("schematic",),
        ("data", "schematic"),
        ("output", "schematic"),
        ("data", "output", "schematic"),
    )
    for path in candidates:
        value: Any = payload
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
        if isinstance(value, dict):
            for key in ("url", "download_url", "file_url"):
                nested = value.get(key)
                if isinstance(nested, str) and nested.startswith("http"):
                    return nested
    raise RuntimeError(f"Tripo conversion response missing downloadable model URL: {payload}")


async def _download_tripo_schematic(*, http_client: httpx.AsyncClient, download_url: str) -> Path:
    parsed = urlparse(download_url)
    suffix = Path(parsed.path).suffix.lower()
    if suffix not in _ALLOWED_EXTENSIONS:
        suffix = ".schem"
    path = Path(tempfile.gettempdir()) / f"browsecraft-tripo-{uuid4()}{suffix}"
    response = await http_client.get(download_url)
    response.raise_for_status()
    path.write_bytes(response.content)
    return path


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
