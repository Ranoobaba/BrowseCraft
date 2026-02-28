from __future__ import annotations

import gzip
import io
import json
from functools import lru_cache
from pathlib import Path

import nbtlib

from .models import BlockPlacement, BuildPlan


class UnsupportedSchematicFormatError(ValueError):
    pass


def parse_schematic_bytes(filename: str, raw: bytes) -> BuildPlan:
    extension = Path(filename).suffix.lower()
    if extension == ".schem":
        return _parse_schem(raw)
    if extension == ".litematic":
        return _parse_litematic(raw)
    if extension == ".schematic":
        return _parse_legacy_schematic(raw)
    raise UnsupportedSchematicFormatError(f"Unsupported schematic format: {extension}")


def _parse_schem(raw: bytes) -> BuildPlan:
    root = _parse_nbt_root(raw)

    width = int(root["Width"])
    height = int(root["Height"])
    length = int(root["Length"])

    if "Blocks" in root and "Palette" in root["Blocks"] and "Data" in root["Blocks"]:
        palette_tag = root["Blocks"]["Palette"]
        data_tag = root["Blocks"]["Data"]
    else:
        palette_tag = root["Palette"]
        data_tag = root["BlockData"]

    palette_by_index = {int(index): str(state) for state, index in palette_tag.items()}

    volume = width * height * length
    decoded = _decode_varints(_tag_to_bytes(data_tag), volume)

    placements: list[BlockPlacement] = []
    for linear_index, palette_index in enumerate(decoded):
        state_string = palette_by_index[palette_index]
        block_id, block_state = _split_block_state(state_string)
        if block_id == "minecraft:air":
            continue

        x = linear_index % width
        z = (linear_index // width) % length
        y = linear_index // (width * length)

        placements.append(
            BlockPlacement(
                dx=x,
                dy=y,
                dz=z,
                block_id=block_id,
                block_state=block_state,
            )
        )

    return BuildPlan(total_blocks=len(placements), placements=placements)


def _parse_litematic(raw: bytes) -> BuildPlan:
    root = _parse_nbt_root(raw)
    regions = root["Regions"]

    placements: list[BlockPlacement] = []
    for region_name in sorted(regions.keys()):
        region = regions[region_name]

        origin_x = int(region["Position"]["x"])
        origin_y = int(region["Position"]["y"])
        origin_z = int(region["Position"]["z"])

        size_x_signed = int(region["Size"]["x"])
        size_y_signed = int(region["Size"]["y"])
        size_z_signed = int(region["Size"]["z"])

        size_x = abs(size_x_signed)
        size_y = abs(size_y_signed)
        size_z = abs(size_z_signed)
        if size_x == 0 or size_y == 0 or size_z == 0:
            continue

        palette = _litematic_palette(region["BlockStatePalette"])

        bits_per_index = max(2, (len(palette) - 1).bit_length())
        packed_states = [int(value) for value in region["BlockStates"]]

        volume = size_x * size_y * size_z
        for linear_index in range(volume):
            palette_index = _read_packed_index(packed_states, bits_per_index, linear_index)
            state_string = palette[palette_index]
            block_id, block_state = _split_block_state(state_string)
            if block_id == "minecraft:air":
                continue

            storage_x = linear_index % size_x
            storage_z = (linear_index // size_x) % size_z
            storage_y = linear_index // (size_x * size_z)

            x = _resolve_region_coord(origin_x, size_x_signed, storage_x)
            y = _resolve_region_coord(origin_y, size_y_signed, storage_y)
            z = _resolve_region_coord(origin_z, size_z_signed, storage_z)

            placements.append(
                BlockPlacement(
                    dx=x,
                    dy=y,
                    dz=z,
                    block_id=block_id,
                    block_state=block_state,
                )
            )

    return BuildPlan(total_blocks=len(placements), placements=placements)


def _parse_legacy_schematic(raw: bytes) -> BuildPlan:
    root = _parse_nbt_root(raw)

    width = int(root["Width"])
    height = int(root["Height"])
    length = int(root["Length"])

    blocks = _tag_to_bytes(root["Blocks"])
    data = _tag_to_bytes(root["Data"])
    add_blocks = _tag_to_bytes(root["AddBlocks"]) if "AddBlocks" in root else b""

    mapping = _legacy_mapping()

    volume = width * height * length
    placements: list[BlockPlacement] = []
    for linear_index in range(volume):
        block_id = blocks[linear_index]
        if add_blocks:
            add_byte = add_blocks[linear_index // 2]
            high_bits = (add_byte & 0x0F) if (linear_index % 2 == 0) else ((add_byte >> 4) & 0x0F)
            block_id |= high_bits << 8

        metadata = data[linear_index] & 0x0F
        state_string = mapping[f"{block_id}:{metadata}"]
        block_id_str, block_state = _split_block_state(state_string)
        if block_id_str == "minecraft:air":
            continue

        x = linear_index % width
        z = (linear_index // width) % length
        y = linear_index // (width * length)

        placements.append(
            BlockPlacement(
                dx=x,
                dy=y,
                dz=z,
                block_id=block_id_str,
                block_state=block_state,
            )
        )

    return BuildPlan(total_blocks=len(placements), placements=placements)


def _parse_nbt_root(raw: bytes) -> nbtlib.File:
    payload = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    return nbtlib.File.parse(io.BytesIO(payload))


def _decode_varints(data: bytes, expected_values: int) -> list[int]:
    values: list[int] = []
    index = 0
    while index < len(data) and len(values) < expected_values:
        value = 0
        shift = 0
        while True:
            byte = data[index]
            index += 1
            value |= (byte & 0x7F) << shift
            if (byte & 0x80) == 0:
                break
            shift += 7
            if shift > 35:
                raise ValueError("VarInt too large")
            if index >= len(data):
                raise ValueError("Unexpected end of varint stream")
        values.append(value)

    if len(values) != expected_values:
        raise ValueError("VarInt block data length does not match schematic volume")

    return values


def _tag_to_bytes(tag: object) -> bytes:
    return bytes((int(value) & 0xFF) for value in tag)


def _litematic_palette(block_state_palette: object) -> list[str]:
    palette: list[str] = []
    for entry in block_state_palette:
        name = str(entry["Name"])
        if "Properties" not in entry:
            palette.append(name)
            continue

        properties = entry["Properties"]
        parts = [f"{key}={properties[key]}" for key in sorted(properties.keys())]
        palette.append(f"{name}[{','.join(parts)}]")

    return palette


def _read_packed_index(values: list[int], bits_per_index: int, item_index: int) -> int:
    bit_offset = item_index * bits_per_index
    word_index = bit_offset // 64
    bit_index = bit_offset % 64
    mask = (1 << bits_per_index) - 1

    current = values[word_index] & 0xFFFFFFFFFFFFFFFF
    if bit_index + bits_per_index <= 64:
        return (current >> bit_index) & mask

    low_bits = 64 - bit_index
    low_part = (current >> bit_index) & ((1 << low_bits) - 1)
    next_word = values[word_index + 1] & 0xFFFFFFFFFFFFFFFF
    high_part = next_word & ((1 << (bits_per_index - low_bits)) - 1)
    return low_part | (high_part << low_bits)


def _resolve_region_coord(origin: int, signed_size: int, storage_index: int) -> int:
    if signed_size >= 0:
        return origin + storage_index
    return origin + signed_size + 1 + storage_index


def _split_block_state(state_string: str) -> tuple[str, dict[str, str]]:
    if "[" not in state_string:
        return state_string, {}

    block_id, raw_properties = state_string.split("[", 1)
    properties_text = raw_properties[:-1] if raw_properties.endswith("]") else raw_properties
    if not properties_text:
        return block_id, {}

    properties: dict[str, str] = {}
    for pair in properties_text.split(","):
        if "=" not in pair:
            continue
        key, value = pair.split("=", 1)
        properties[key] = value

    return block_id, properties


@lru_cache
def _legacy_mapping() -> dict[str, str]:
    path = Path(__file__).with_name("legacy_blocks.json")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)
