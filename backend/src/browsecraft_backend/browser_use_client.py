from __future__ import annotations

import logging
import re
from pathlib import Path

from browser_use_sdk import AsyncBrowserUse, TaskOutputFileResponse
from pydantic import BaseModel, Field

from .sources import CandidateFile
from .sponsors import laminar_span


logger = logging.getLogger(__name__)


PROMPT_TEMPLATE = """Go to planetminecraft.com and find downloadable Minecraft Java schematic files.
Use only Planet Minecraft pages.
Search for the query and open project pages.
On each project, use the Schematic download tab/button path.
Never use World Save or map downloads. Never use .zip downloads.
If a project only offers World Save/.zip, skip it and continue.
Download only files with allowed extensions so they appear in task output files.
Stop if you revisit the same page repeatedly and move to the next result.
Return only candidates backed by downloaded files with allowed extensions.
Query: {query}
Minecraft Version: {mc_version}
Allowed extensions: {allowed_exts}
Target site: planetminecraft.com"""


class BrowsedCandidate(BaseModel):
    canonical_url: str
    filename: str
    title: str
    score: float = Field(default=0.5)
    download_url: str | None = None


class BrowsedCandidates(BaseModel):
    candidates: list[BrowsedCandidate] = Field(default_factory=list)


class BrowserUseService:
    def __init__(
        self,
        api_key: str | None,
        primary_model: str,
        fallback_model: str,
        timeout_seconds: int,
    ) -> None:
        self._api_key = api_key
        self._primary_model = primary_model
        self._fallback_model = fallback_model
        self._timeout_seconds = timeout_seconds

    async def discover_via_browsing(
        self,
        query: str,
        mc_version: str,
        allowed_exts: tuple[str, ...],
    ) -> list[CandidateFile]:
        if not self._api_key:
            return []

        allowed_exts_str = ", ".join(allowed_exts)
        prompt = PROMPT_TEMPLATE.format(
            query=query,
            mc_version=mc_version,
            allowed_exts=allowed_exts_str,
        )

        models = [self._primary_model]
        if self._fallback_model and self._fallback_model != self._primary_model:
            models.append(self._fallback_model)

        last_error: Exception | None = None
        for model in models:
            client = AsyncBrowserUse(api_key=self._api_key, timeout=float(self._timeout_seconds))
            try:
                with laminar_span(
                    "browser_use.task_run",
                    payload={
                        "query": query,
                        "mc_version": mc_version,
                        "model": model,
                    },
                ):
                    logger.info(
                        "Starting browser-use task",
                        extra={
                            "model": model,
                            "query": query,
                            "mc_version": mc_version,
                            "timeout_seconds": self._timeout_seconds,
                        },
                    )
                    task = client.run(
                        task=prompt,
                        output_schema=BrowsedCandidates,
                        llm=model,
                        max_steps=24,
                        allowed_domains=["planetminecraft.com", "www.planetminecraft.com"],
                    )
                    result = await task
                task_id = task.task_id
                if task_id is None:
                    raise RuntimeError("browser-use task id missing")

                output = result.output
                if output is None:
                    return []
                if not isinstance(output, BrowsedCandidates):
                    raise TypeError("browser-use returned unexpected output payload")

                output_files = await self._fetch_output_files(client, task_id, result.task.output_files)
                return self._filter_candidates(
                    candidates=output.candidates,
                    output_files=output_files,
                    allowed_exts=allowed_exts,
                    task_id=task_id,
                )
            except Exception as exc:
                last_error = exc
            finally:
                await client.close()

        if last_error is not None:
            raise last_error
        return []

    async def _fetch_output_files(
        self,
        client: AsyncBrowserUse,
        task_id: str,
        output_files: list,
    ) -> dict[str, TaskOutputFileResponse]:
        with laminar_span(
            "browser_use.fetch_output_files",
            payload={"task_id": task_id, "output_file_count": len(output_files)},
        ):
            logger.info(
                "Fetching browser-use output files",
                extra={"task_id": task_id, "output_file_count": len(output_files)},
            )
            files_by_name: dict[str, TaskOutputFileResponse] = {}
            for output_file in output_files:
                file_response = await client.files.task_output(task_id, str(output_file.id))
                files_by_name[_normalize_filename(file_response.file_name)] = file_response
            return files_by_name

    def _filter_candidates(
        self,
        candidates: list[BrowsedCandidate],
        output_files: dict[str, TaskOutputFileResponse],
        allowed_exts: tuple[str, ...],
        task_id: str,
    ) -> list[CandidateFile]:
        filtered: list[CandidateFile] = []
        for candidate in candidates:
            candidate_filename = Path(candidate.filename).name
            candidate_ext = Path(candidate_filename).suffix.lower()
            if candidate_ext not in allowed_exts:
                continue

            normalized_name = _normalize_filename(candidate_filename)
            output_file = output_files.get(normalized_name)
            if output_file is None:
                continue

            filtered.append(
                CandidateFile(
                    source="browser_use",
                    canonical_url=candidate.canonical_url,
                    download_url=candidate.download_url or output_file.download_url,
                    filename=candidate_filename,
                    title=candidate.title,
                    score=candidate.score,
                    browser_task_id=task_id,
                    browser_output_file_id=str(output_file.id),
                )
            )

        return filtered


def _normalize_filename(value: str) -> str:
    return re.sub(r"\s+", "", Path(value).name.lower())
