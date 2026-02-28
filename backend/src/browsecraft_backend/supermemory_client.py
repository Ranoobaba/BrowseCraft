from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .sponsors import laminar_span

_SUPERMEMORY_BASE_URL = "https://api.supermemory.ai"


class _SearchRequest(BaseModel):
    q: str = Field(min_length=1)
    containerTag: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=20)
    searchMode: str = "memories"


class _SearchResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    memory: str | None = None
    chunk: str | None = None
    similarity: float | None = None


class _SearchResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    results: list[_SearchResult]


class _CreateMemory(BaseModel):
    content: str = Field(min_length=1)
    isStatic: bool = False
    metadata: dict[str, Any]


class _CreateMemoriesRequest(BaseModel):
    containerTag: str = Field(min_length=1)
    memories: list[_CreateMemory] = Field(min_length=1)


@dataclass(slots=True, frozen=True)
class SupermemorySearchResult:
    text: str
    similarity: float | None


class SupermemoryClient:
    def __init__(
        self,
        api_key: str,
        http_client: httpx.AsyncClient,
        *,
        base_url: str = _SUPERMEMORY_BASE_URL,
    ) -> None:
        self._api_key = api_key
        self._http_client = http_client
        self._base_url = base_url.rstrip("/")

    async def search_memories(
        self,
        query: str,
        *,
        container_tag: str,
        limit: int = 5,
    ) -> list[SupermemorySearchResult]:
        request_payload = _SearchRequest(q=query, containerTag=container_tag, limit=limit)
        with laminar_span(
            "supermemory.search",
            payload={
                "container_tag": container_tag,
                "query": query,
                "limit": limit,
            },
        ):
            response = await self._http_client.post(
                f"{self._base_url}/v4/search",
                headers=self._headers(),
                json=request_payload.model_dump(mode="json"),
            )
        response.raise_for_status()
        parsed = _SearchResponse.model_validate(response.json())

        results: list[SupermemorySearchResult] = []
        for hit in parsed.results:
            text = hit.memory or hit.chunk
            if text is None:
                continue
            results.append(SupermemorySearchResult(text=text, similarity=hit.similarity))
        return results

    async def store_memory(
        self,
        content: str,
        *,
        container_tag: str,
        metadata: dict[str, Any],
    ) -> None:
        request_payload = _CreateMemoriesRequest(
            containerTag=container_tag,
            memories=[_CreateMemory(content=content, metadata=metadata)],
        )
        with laminar_span(
            "supermemory.store",
            payload={
                "container_tag": container_tag,
                "content": content,
            },
        ):
            response = await self._http_client.post(
                f"{self._base_url}/v4/memories",
                headers=self._headers(),
                json=request_payload.model_dump(mode="json"),
            )
        response.raise_for_status()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
