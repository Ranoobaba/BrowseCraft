from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from anthropic import AsyncAnthropic
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from .models import BlockPlacement, BuildPlan
from .sponsors import laminar_span


logger = logging.getLogger(__name__)

GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview"
ANTHROPIC_VISION_MODEL = "claude-opus-4-6"
MAX_IMAGINE_PLACEMENTS = 499
_PLAN_TOOL_NAME = "emit_build_plan"


class ImaginePipeline(Protocol):
    async def build_plan(self, prompt: str) -> BuildPlan:
        ...


GoogleClientFactory = Callable[[str], genai.Client]
AnthropicClientFactory = Callable[[str], AsyncAnthropic]


@dataclass(slots=True)
class _GeneratedImage:
    data: bytes
    mime_type: str


class _ToolPlacement(BaseModel):
    dx: int
    dy: int
    dz: int
    block_id: str
    block_state: dict[str, str] = Field(default_factory=dict)


class _ToolPlanPayload(BaseModel):
    placements: list[_ToolPlacement] = Field(min_length=1, max_length=MAX_IMAGINE_PLACEMENTS)


class ImagineService:
    def __init__(
        self,
        google_api_key: str | None,
        anthropic_api_key: str | None,
        google_client_factory: GoogleClientFactory | None = None,
        anthropic_client_factory: AnthropicClientFactory | None = None,
    ) -> None:
        self._google_api_key = google_api_key
        self._anthropic_api_key = anthropic_api_key
        self._google_client_factory = google_client_factory or (lambda api_key: genai.Client(api_key=api_key))
        self._anthropic_client_factory = anthropic_client_factory or (lambda api_key: AsyncAnthropic(api_key=api_key))

    async def build_plan(self, prompt: str) -> BuildPlan:
        if not self._google_api_key:
            raise RuntimeError("GOOGLE_API_KEY is required for imagine pipeline")
        if not self._anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is required for imagine pipeline")

        generated_image = await self._generate_image(prompt)
        return await self._convert_image_to_plan(prompt, generated_image)

    async def _generate_image(self, prompt: str) -> _GeneratedImage:
        client = self._google_client_factory(self._google_api_key)
        try:
            with laminar_span(
                "imagine.gemini.generate_image",
                payload={"model": GEMINI_IMAGE_MODEL, "prompt": prompt},
            ):
                logger.info(
                    "Imagine pipeline: generating reference image",
                    extra={"provider": "google", "model": GEMINI_IMAGE_MODEL, "prompt_length": len(prompt)},
                )
                response = await client.aio.models.generate_content(
                    model=GEMINI_IMAGE_MODEL,
                    contents=[prompt],
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE"],
                        image_config=types.ImageConfig(output_mime_type="image/png"),
                    ),
                )
        finally:
            await client.aio.aclose()

        for candidate in response.candidates or []:
            if candidate.content is None:
                continue
            for part in candidate.content.parts or []:
                inline_data = part.inline_data
                if inline_data is None:
                    continue
                if inline_data.data is None:
                    raise RuntimeError("Gemini response image data was empty")
                if inline_data.mime_type is None:
                    raise RuntimeError("Gemini response image mime type was missing")
                return _GeneratedImage(data=inline_data.data, mime_type=inline_data.mime_type)

        raise RuntimeError("Gemini response did not include image bytes")

    async def _convert_image_to_plan(self, prompt: str, generated_image: _GeneratedImage) -> BuildPlan:
        client = self._anthropic_client_factory(self._anthropic_api_key)
        image_b64 = base64.b64encode(generated_image.data).decode("utf-8")
        try:
            with laminar_span(
                "imagine.anthropic.convert_to_blocks",
                payload={
                    "model": ANTHROPIC_VISION_MODEL,
                    "prompt": prompt,
                    "mime_type": generated_image.mime_type,
                    "image_bytes": len(generated_image.data),
                },
            ):
                logger.info(
                    "Imagine pipeline: converting image to block placements",
                    extra={
                        "provider": "anthropic",
                        "model": ANTHROPIC_VISION_MODEL,
                        "mime_type": generated_image.mime_type,
                        "image_bytes": len(generated_image.data),
                    },
                )
                message = await client.messages.create(
                    model=ANTHROPIC_VISION_MODEL,
                    max_tokens=4096,
                    temperature=0,
                    tools=[
                        {
                            "name": _PLAN_TOOL_NAME,
                            "description": "Return a Minecraft block placement plan as JSON.",
                            "input_schema": _ToolPlanPayload.model_json_schema(),
                        }
                    ],
                    tool_choice={
                        "type": "tool",
                        "name": _PLAN_TOOL_NAME,
                        "disable_parallel_tool_use": True,
                    },
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": _build_vision_prompt(prompt),
                                },
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": generated_image.mime_type,
                                        "data": image_b64,
                                    },
                                },
                            ],
                        }
                    ],
                )
        finally:
            await client.close()

        tool_input = _extract_tool_input(message.content)
        parsed = _ToolPlanPayload.model_validate(tool_input)
        placements = [
            BlockPlacement(
                dx=placement.dx,
                dy=placement.dy,
                dz=placement.dz,
                block_id=placement.block_id,
                block_state=placement.block_state,
            )
            for placement in parsed.placements
        ]
        return BuildPlan(total_blocks=len(placements), placements=placements)


def _extract_tool_input(content_blocks: list[Any]) -> dict[str, Any]:
    for block in content_blocks:
        if getattr(block, "type", None) != "tool_use":
            continue
        if getattr(block, "name", None) != _PLAN_TOOL_NAME:
            continue
        block_input = getattr(block, "input", None)
        if not isinstance(block_input, dict):
            raise RuntimeError("Anthropic tool output must be a JSON object")
        return block_input
    raise RuntimeError("Anthropic response missing tool output for imagine plan")


def _build_vision_prompt(prompt: str) -> str:
    return (
        "Convert the image into a Minecraft build plan.\n"
        "Return block placements using relative coordinates around origin.\n"
        f"Use fewer than {MAX_IMAGINE_PLACEMENTS + 1} placements.\n"
        "Use minecraft namespace block IDs.\n"
        "Include block_state only when needed for orientation or redstone behavior.\n"
        f"User request: {prompt}"
    )
