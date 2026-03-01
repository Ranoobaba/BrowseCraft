from __future__ import annotations

import asyncio
import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4
from urllib.parse import unquote, urlsplit

import httpx
from browser_use_sdk import AsyncBrowserUse as AsyncBrowserUseV2
from browser_use_sdk.v3 import AsyncBrowserUse as AsyncBrowserUseV3
from browser_use_sdk._core.errors import BrowserUseError
from pydantic import BaseModel, Field

from .models import AsyncJobAcceptedResponse, ChatAcceptedResponse, ChatRequest, ImagineRequest, SearchRequest
from .schematic_parser import parse_schematic
from .websocket_manager import WebSocketManager

logger = logging.getLogger(__name__)

_ALLOWED_EXTENSIONS = (".schem", ".litematic", ".schematic")
_PLANET_MINECRAFT_ALLOWED_DOMAINS = ("planetminecraft.com", "www.planetminecraft.com")
_PLANET_MINECRAFT_MAX_STEPS = 10
_PLANET_MINECRAFT_START_URL = "https://www.planetminecraft.com/"
_PLANET_MINECRAFT_SYSTEM_GUIDANCE = """Use Planet Minecraft only.

Rules:
1. Stay on Planet Minecraft and only follow schematic project pages.
2. Return only direct schematic files with extensions .schem, .litematic, or .schematic.
3. Never return /download/worldmap/, world-save, or archive/worldmap endpoints.
4. Do not return page links. Every candidate must include a direct downloadable file URL.
5. Return no more than 3 candidates, sorted by quality.
"""
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


def _build_search_task(query: str) -> str:
    return f"{_PLANET_MINECRAFT_PROMPT.format(query=query)}\n\n{_PLANET_MINECRAFT_SYSTEM_GUIDANCE}"
_PLANET_MINECRAFT_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
}

_V3_MODELS = ("bu-mini", "bu-max")
_V2_FALLBACK_LLM = "browser-use-llm"


# Keep this alias for tests that monkeypatch this symbol (v3 search path).
AsyncBrowserUse = AsyncBrowserUseV3


def _filename_from_url(value: str | None) -> str:
    if not value:
        return ""
    return unquote(urlsplit(value).path).rsplit("/", maxsplit=1)[-1]


def _normalize_browser_use_model_v3(value: str | None) -> str | None:
    if value is None:
        return None
    if value in _V3_MODELS:
        return value

    logger.warning("Unsupported browser-use model '%s'. Falling back to Browser-Use v3 default model.", value)
    return None


def _normalize_browser_use_model_v2(value: str | None) -> str:
    if value is None:
        return _V2_FALLBACK_LLM
    if value in _V3_MODELS:
        return _V2_FALLBACK_LLM
    return value


def _should_fallback_to_v2(exc: Exception) -> bool:
    if isinstance(exc, BrowserUseError):
        return exc.status_code in (422, 500, 503)
    return False


def _is_broken_download_url(url: str | None) -> bool:
    if not url:
        return False
    lowered = url.lower()
    return "/worldmap/" in lowered or "world-save" in lowered or "world_save" in lowered


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
        chat_submitter: Callable[[ChatRequest], Awaitable[ChatAcceptedResponse]] | None,
    ) -> None:
        self._websocket_manager = websocket_manager
        self._browser_use_api_key = browser_use_api_key
        self._browser_use_llm = browser_use_llm
        self._browser_use_skill_id = browser_use_skill_id
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
        if self._chat_submitter is not None:
            await self._emit_status(client_id, "🎨 Designing creative structure...")
            await self._chat_submitter(
                ChatRequest(
                    client_id=client_id,
                    mode="plan_fast",
                    message=(
                        f"Plan and preview a creative detailed build for: {prompt}. "
                        "Output the complete structure in one set_plan call. "
                        "Use varied materials, depth, layered silhouettes, decorative trim, windows/overhangs, "
                        "and stairs/slabs for detail."
                    ),
                )
            )
            return

        message = "Imagine is unavailable because chat orchestration is not configured."
        await self._emit_chat_response(client_id=client_id, job_id=job_id, message=message)

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

    async def _search_and_download(
        self,
        *,
        query: str,
        status_callback: Callable[[str], Awaitable[None]],
    ) -> _DownloadedSchematic:
        if not self._browser_use_api_key:
            raise RuntimeError("BROWSER_USE_API_KEY is required for /search")

        browser_v3 = AsyncBrowserUseV3(api_key=self._browser_use_api_key, timeout=300.0)
        should_fallback_to_v2 = False
        try:
            result = await self._search_via_browser_use_v3(
                browser=browser_v3,
                query=query,
            )
            return await _finalize_download(
                browser=browser_v3,
                result=result,
                status_callback=status_callback,
            )
        except BrowserUseError as exc:
            if not _should_fallback_to_v2(exc):
                raise
            logger.warning(
                "Search via Browser-Use v3 failed with %s (%s). Falling back to v2 runtime.",
                exc.status_code,
                exc,
            )
            await status_callback("⚠️ Browser-Use v3 unavailable, retrying with v2 runtime.")
            should_fallback_to_v2 = True
        finally:
            await browser_v3.close()

        browser_v2 = AsyncBrowserUseV2(api_key=self._browser_use_api_key, timeout=300.0)
        try:
            result = await self._search_via_browser_use_v2(
                browser=browser_v2,
                query=query,
            )
            return await _finalize_download(
                browser=browser_v2,
                result=result,
                status_callback=status_callback,
            )
        finally:
            await browser_v2.close()

    async def _search_via_browser_use_v3(
        self,
        *,
        browser: AsyncBrowserUseV3,
        query: str,
    ) -> Any:
        payload = {
            "task": _build_search_task(query),
            "output_schema": _SearchCandidates,
        }

        model = _normalize_browser_use_model_v3(self._browser_use_llm)
        if model is not None:
            payload["model"] = model
            retry_payload = {"task": payload["task"], "output_schema": _SearchCandidates}
            payloads = (payload, retry_payload)
        else:
            payloads = (payload,)

        last_error: Exception | None = None
        for search_payload in payloads:
            try:
                return await browser.run(**search_payload)
            except BrowserUseError as exc:
                if (
                    model is not None
                    and search_payload is payload
                    and exc.status_code == 422
                ):
                    logger.warning(
                        "Search via Browser-Use v3 rejected with %s (%s). Retrying with stripped payload.",
                        exc.status_code,
                        exc,
                    )
                    last_error = exc
                    continue
                last_error = exc
                raise

        raise RuntimeError(f"Browser-Use v3 search failed: {last_error}")

    async def _search_via_browser_use_v2(
        self,
        *,
        browser: AsyncBrowserUseV2,
        query: str,
    ) -> Any:
        search_kwargs = {
            "task": _build_search_task(query),
            "output_schema": _SearchCandidates,
            "llm": _normalize_browser_use_model_v2(self._browser_use_llm),
            "start_url": _PLANET_MINECRAFT_START_URL,
            "max_steps": _PLANET_MINECRAFT_MAX_STEPS,
            "allowed_domains": list(_PLANET_MINECRAFT_ALLOWED_DOMAINS),
            "flash_mode": True,
            "thinking": False,
            "vision": False,
            "system_prompt_extension": _PLANET_MINECRAFT_SYSTEM_GUIDANCE,
        }
        if self._browser_use_skill_id is not None:
            search_kwargs["skill_ids"] = [self._browser_use_skill_id]
        return await browser.run(**search_kwargs)


async def _finalize_download(
    *,
    browser: Any,
    result: Any,
    status_callback: Callable[[str], Awaitable[None]],
) -> _DownloadedSchematic:
    candidates = _ordered_candidates(result.output)
    if not candidates:
        raise RuntimeError("No schematic candidates found")
    await status_callback(f"✅ Found: {candidates[0].title}")
    await status_callback("📥 Downloading schematic...")

    last_error: Exception | None = None
    with tempfile.TemporaryDirectory(prefix="browsecraft-search-") as temp_dir:
        for candidate in candidates:
            try:
                downloaded = await _download_candidate(
                    browser=browser,
                    result=result,
                    candidate=candidate,
                    target_dir=Path(temp_dir),
                )
                break
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Failed to download candidate %s (%s): %s",
                    candidate.filename,
                    candidate.canonical_url,
                    exc,
                )
                continue
        else:
            raise RuntimeError(f"All candidates failed download; last error: {last_error}")
        persistent = Path(tempfile.gettempdir()) / f"browsecraft-{uuid4()}{downloaded.path.suffix.lower()}"
        persistent.write_bytes(downloaded.path.read_bytes())
        return _DownloadedSchematic(
            path=persistent,
            title=downloaded.title,
            source_url=downloaded.source_url,
        )


def _best_candidate(output: _SearchCandidates | str | None) -> _SearchCandidate | None:
    if output is None or isinstance(output, str):
        return None
    if not output.candidates:
        return None
    sorted_candidates = sorted(output.candidates, key=lambda item: item.score, reverse=True)
    return next((candidate for candidate in sorted_candidates if _is_candidate_file(candidate)), None)


def _ordered_candidates(output: _SearchCandidates | str | None) -> list[_SearchCandidate]:
    if output is None or isinstance(output, str):
        return []
    if not output.candidates:
        return []

    sorted_candidates = sorted(output.candidates, key=lambda item: item.score, reverse=True)
    result: list[_SearchCandidate] = []
    for candidate in sorted_candidates:
        if _is_candidate_file(candidate):
            result.append(candidate)
    return result[:3]


def _is_candidate_file(candidate: _SearchCandidate) -> bool:
    filename = _filename_from_candidate(candidate).lower()
    if _is_broken_download_url(candidate.download_url):
        return False
    return any(filename.endswith(ext) for ext in _ALLOWED_EXTENSIONS)


async def _download_candidate(
    *,
    browser: Any,
    result: Any,
    candidate: _SearchCandidate,
    target_dir: Path,
) -> _DownloadedSchematic:
    target_dir.mkdir(parents=True, exist_ok=True)

    download_url = candidate.download_url
    filename = _filename_from_candidate(candidate)
    if not filename:
        raise RuntimeError(f"Candidate did not include a usable filename: {candidate.title}")
    if download_url:
        try:
            file_path = await _download_via_url(
                browser_http_client_factory=httpx.AsyncClient,
                download_url=download_url,
                filename=filename,
                target_dir=target_dir,
                referer=candidate.canonical_url,
            )
            return _DownloadedSchematic(path=file_path, title=candidate.title, source_url=candidate.canonical_url)
        except Exception as exc:
            if not isinstance(exc, httpx.HTTPStatusError):
                raise
            logger.warning(
                "Direct schematic download failed for %s, trying session files",
                candidate.filename,
            )

    return await _download_from_session_files(
        browser=browser,
        result=result,
        candidate=candidate,
        filename=filename,
        target_dir=target_dir,
    )


async def _download_via_url(
    *,
    browser_http_client_factory: Callable[..., httpx.AsyncClient],
    download_url: str,
    filename: str,
    target_dir: Path,
    referer: str | None = None,
) -> Path:
    if _is_broken_download_url(download_url):
        raise RuntimeError("Download URL targets map/world endpoint instead of schematic file")

    headers = _PLANET_MINECRAFT_DOWNLOAD_HEADERS.copy()
    if referer is not None:
        headers["Referer"] = referer

    async with browser_http_client_factory(follow_redirects=True, timeout=120.0, headers=headers) as http_client:
        response = await http_client.get(download_url)
        response.raise_for_status()
        file_path = target_dir / filename
        file_path.write_bytes(response.content)
        return file_path


async def _download_from_session_files(
    *,
    browser: Any,
    result: Any,
    candidate: _SearchCandidate,
    filename: str,
    target_dir: Path,
) -> _DownloadedSchematic:
    file_target = None
    result_task = getattr(result, "task", None)
    result_session = getattr(result, "session", None)
    task_output_files = getattr(result_task, "output_files", None) if result_task is not None else None

    if result_session is not None:
        file_list = await browser.sessions.files(str(result_session.id), include_urls=True)
        file_views = list(file_list.files or [])
        file_name_key = "path"
        file_url_key = "url"
    elif task_output_files is not None:
        file_views = list(task_output_files)
        file_name_key = "file_name"
        file_url_key = "download_url"
    else:
        raise RuntimeError("Candidate download failed and session/task output files were unavailable")

    def _read_file_name(file_view: Any) -> str:
        for key in (file_name_key, "path", "name", "filename"):
            value = getattr(file_view, key, None)
            if isinstance(value, str):
                return value
        return ""

    def _read_file_url(file_view: Any) -> str | None:
        for key in (file_url_key, "url", "download_url"):
            value = getattr(file_view, key, None)
            if isinstance(value, str):
                return value
        return None

    def _matches_file(file_view: Any, target: str) -> bool:
        candidate_name = _read_file_name(file_view).lower()
        if not candidate_name:
            return False
        return candidate_name.lower().endswith(target.lower())

    for file_view in file_views:
        if _matches_file(file_view, filename):
            file_target = file_view
            break

    if file_target is None:
        for file_view in file_views:
            file_name = _read_file_name(file_view).lower()
            if any(file_name.endswith(ext) for ext in _ALLOWED_EXTENSIONS):
                file_target = file_view
                break

    if file_target is None:
        raise RuntimeError("No suitable output file was found in browser session")

    download_url = _read_file_url(file_target)
    if download_url is None and result_task is not None:
        file_id = getattr(file_target, "id", None)
        if file_id is None:
            raise RuntimeError("Output file has no downloadable URL")

        if not hasattr(browser, "files"):
            raise RuntimeError("Output file has no downloadable URL")

        task_output = await browser.files.task_output(str(result_task.id), str(file_id))
        download_url = _read_file_url(task_output)

    if download_url is None:
        raise RuntimeError("No suitable output file URL was found in browser session")

    if candidate.filename and candidate.filename.lower().endswith(".zip"):
        raise RuntimeError("Candidate file is a map/world-save archive")

    file_path = await _download_via_url(
        browser_http_client_factory=httpx.AsyncClient,
        download_url=download_url,
        filename=filename,
        target_dir=target_dir,
    )
    return _DownloadedSchematic(path=file_path, title=candidate.title, source_url=candidate.canonical_url)


def _filename_from_candidate(candidate: _SearchCandidate) -> str:
    if candidate.filename.strip():
        extracted = _filename_from_url(candidate.filename)
        if extracted:
            return extracted
    return _filename_from_url(candidate.download_url)
