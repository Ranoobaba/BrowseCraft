from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

SourceName = Literal["github", "modrinth", "curseforge", "browser_use"]


@dataclass(slots=True)
class CandidateFile:
    source: SourceName
    canonical_url: str
    download_url: str
    filename: str
    title: str
    score: float
    browser_task_id: str | None = None
    browser_output_file_id: str | None = None

    @property
    def extension(self) -> str:
        return Path(self.filename).suffix.lower()


class GitHubSourceAdapter:
    def __init__(self, token: str | None, http_client: httpx.AsyncClient) -> None:
        self._token = token
        self._http_client = http_client

    async def search(self, query: str, mc_version: str, allowed_exts: tuple[str, ...]) -> list[CandidateFile]:
        del mc_version
        if not self._token:
            return []

        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self._token}",
        }

        candidates: list[CandidateFile] = []
        for extension in allowed_exts:
            response = await self._http_client.get(
                "https://api.github.com/search/code",
                params={
                    "q": f"{query} extension:{extension.lstrip('.')}",
                    "per_page": 10,
                },
                headers=headers,
            )
            response.raise_for_status()

            payload = response.json()
            for item in payload.get("items", []):
                content_url = item.get("url")
                if not content_url:
                    continue

                content_response = await self._http_client.get(content_url, headers=headers)
                content_response.raise_for_status()
                content_payload = content_response.json()
                download_url = content_payload.get("download_url")
                if not download_url:
                    continue

                filename = item.get("name") or Path(download_url).name
                if Path(filename).suffix.lower() not in allowed_exts:
                    continue

                title = item.get("path") or filename
                candidates.append(
                    CandidateFile(
                        source="github",
                        canonical_url=item.get("html_url") or download_url,
                        download_url=download_url,
                        filename=filename,
                        title=title,
                        score=float(item.get("score") or 0.0),
                    )
                )

        return candidates


class ModrinthSourceAdapter:
    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._http_client = http_client

    async def search(self, query: str, mc_version: str, allowed_exts: tuple[str, ...]) -> list[CandidateFile]:
        search_response = await self._http_client.get(
            "https://api.modrinth.com/v2/search",
            params={"query": query, "limit": 10},
        )
        search_response.raise_for_status()

        hits = search_response.json().get("hits", [])
        candidates: list[CandidateFile] = []
        for hit in hits:
            project_id = hit.get("project_id")
            if not project_id:
                continue

            versions_response = await self._http_client.get(
                f"https://api.modrinth.com/v2/project/{project_id}/version",
                params={"game_versions": f'["{mc_version}"]'},
            )
            versions_response.raise_for_status()

            slug = hit.get("slug") or project_id
            canonical_url = f"https://modrinth.com/project/{slug}"
            for version in versions_response.json():
                for file_info in version.get("files", []):
                    filename = file_info.get("filename")
                    download_url = file_info.get("url")
                    if not filename or not download_url:
                        continue
                    if Path(filename).suffix.lower() not in allowed_exts:
                        continue

                    candidates.append(
                        CandidateFile(
                            source="modrinth",
                            canonical_url=canonical_url,
                            download_url=download_url,
                            filename=filename,
                            title=hit.get("title") or filename,
                            score=float(hit.get("downloads") or 0.0),
                        )
                    )

        return candidates


class CurseForgeSourceAdapter:
    def __init__(self, api_key: str | None, http_client: httpx.AsyncClient) -> None:
        self._api_key = api_key
        self._http_client = http_client

    async def search(self, query: str, mc_version: str, allowed_exts: tuple[str, ...]) -> list[CandidateFile]:
        if not self._api_key:
            return []

        headers = {"x-api-key": self._api_key}
        search_response = await self._http_client.get(
            "https://api.curseforge.com/v1/mods/search",
            params={
                "gameId": 432,
                "searchFilter": query,
                "sortField": 2,
                "sortOrder": "desc",
                "pageSize": 10,
            },
            headers=headers,
        )
        search_response.raise_for_status()

        candidates: list[CandidateFile] = []
        for mod in search_response.json().get("data", []):
            mod_id = mod.get("id")
            if mod_id is None:
                continue

            files_response = await self._http_client.get(
                f"https://api.curseforge.com/v1/mods/{mod_id}/files",
                params={"gameVersion": mc_version, "pageSize": 25},
                headers=headers,
            )
            files_response.raise_for_status()

            canonical_url = mod.get("links", {}).get("websiteUrl") or ""
            for file_info in files_response.json().get("data", []):
                filename = file_info.get("fileName")
                download_url = file_info.get("downloadUrl")
                if not filename or not download_url:
                    continue
                if Path(filename).suffix.lower() not in allowed_exts:
                    continue

                candidates.append(
                    CandidateFile(
                        source="curseforge",
                        canonical_url=canonical_url or download_url,
                        download_url=download_url,
                        filename=filename,
                        title=mod.get("name") or filename,
                        score=float(mod.get("downloadCount") or 0.0),
                    )
                )

        return candidates


class SourceDiscovery:
    def __init__(
        self,
        github: GitHubSourceAdapter,
        modrinth: ModrinthSourceAdapter,
        curseforge: CurseForgeSourceAdapter,
    ) -> None:
        self._github = github
        self._modrinth = modrinth
        self._curseforge = curseforge

    async def search(self, query: str, mc_version: str, allowed_exts: tuple[str, ...]) -> list[CandidateFile]:
        github_results, modrinth_results, curseforge_results = await asyncio.gather(
            self._github.search(query, mc_version, allowed_exts),
            self._modrinth.search(query, mc_version, allowed_exts),
            self._curseforge.search(query, mc_version, allowed_exts),
        )
        merged = [*github_results, *modrinth_results, *curseforge_results]

        priority = {
            ".schem": 0,
            ".litematic": 1,
            ".schematic": 2,
        }
        merged.sort(key=lambda candidate: (priority.get(candidate.extension, 100), -candidate.score))
        return merged
