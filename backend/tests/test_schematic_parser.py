from __future__ import annotations

import gzip
import io

import nbtlib
import pytest

from browsecraft_backend.schematic_parser import UnsupportedSchematicFormatError, parse_schematic_bytes


def _write_nbt(root: nbtlib.Compound, root_name: str) -> bytes:
    buf = io.BytesIO()
    nbtlib.File(root, root_name=root_name).write(buf)
    return buf.getvalue()


def _encode_varints(values: list[int]) -> list[int]:
    output: list[int] = []
    for value in values:
        part = value
        while True:
            temp = part & 0x7F
            part >>= 7
            if part != 0:
                output.append(temp | 0x80)
            else:
                output.append(temp)
                break
    return [byte if byte < 128 else byte - 256 for byte in output]


def _pack_indices(indices: list[int], bits: int) -> list[int]:
    total_bits = len(indices) * bits
    words = [0] * ((total_bits + 63) // 64)
    mask = (1 << bits) - 1
    for index, value in enumerate(indices):
        bit_offset = index * bits
        word_index = bit_offset // 64
        intra_word = bit_offset % 64
        words[word_index] |= (value & mask) << intra_word
        spill = intra_word + bits - 64
        if spill > 0:
            words[word_index + 1] |= (value & mask) >> (bits - spill)

    signed_words: list[int] = []
    for word in words:
        word &= (1 << 64) - 1
        if word >= (1 << 63):
            word -= 1 << 64
        signed_words.append(word)
    return signed_words


def test_parse_schem_v2_gzip_with_varints() -> None:
    root = nbtlib.Compound(
        {
            "Width": nbtlib.Short(2),
            "Height": nbtlib.Short(1),
            "Length": nbtlib.Short(2),
            "Palette": nbtlib.Compound(
                {
                    "minecraft:air": nbtlib.Int(0),
                    "minecraft:oak_log[axis=y]": nbtlib.Int(1),
                    "minecraft:stone": nbtlib.Int(130),
                }
            ),
            "BlockData": nbtlib.ByteArray(_encode_varints([130, 0, 1, 130])),
        }
    )

    raw = gzip.compress(_write_nbt(root, "Schematic"))
    plan = parse_schematic_bytes("house.schem", raw)

    assert plan.total_blocks == 3
    assert plan.placements[0].block_id == "minecraft:stone"
    assert (plan.placements[0].dx, plan.placements[0].dy, plan.placements[0].dz) == (0, 0, 0)
    assert plan.placements[1].block_id == "minecraft:oak_log"
    assert plan.placements[1].block_state == {"axis": "y"}


def test_parse_schem_v3_blocks_palette() -> None:
    root = nbtlib.Compound(
        {
            "Width": nbtlib.Short(2),
            "Height": nbtlib.Short(1),
            "Length": nbtlib.Short(1),
            "Blocks": nbtlib.Compound(
                {
                    "Palette": nbtlib.Compound(
                        {
                            "minecraft:air": nbtlib.Int(0),
                            "minecraft:cobblestone": nbtlib.Int(1),
                        }
                    ),
                    "Data": nbtlib.ByteArray(_encode_varints([1, 0])),
                }
            ),
        }
    )

    raw = _write_nbt(root, "Schematic")
    plan = parse_schematic_bytes("wall.schem", raw)

    assert plan.total_blocks == 1
    placement = plan.placements[0]
    assert placement.block_id == "minecraft:cobblestone"
    assert (placement.dx, placement.dy, placement.dz) == (0, 0, 0)


def test_parse_litematic_with_negative_size_and_cross_word_indices() -> None:
    indices = [0] * 34
    indices[0] = 1
    indices[33] = 2
    packed = _pack_indices(indices, bits=2)

    region = nbtlib.Compound(
        {
            "Position": nbtlib.Compound(
                {
                    "x": nbtlib.Int(10),
                    "y": nbtlib.Int(5),
                    "z": nbtlib.Int(20),
                }
            ),
            "Size": nbtlib.Compound(
                {
                    "x": nbtlib.Int(-17),
                    "y": nbtlib.Int(1),
                    "z": nbtlib.Int(2),
                }
            ),
            "BlockStatePalette": nbtlib.List[nbtlib.Compound](
                [
                    nbtlib.Compound({"Name": nbtlib.String("minecraft:air")}),
                    nbtlib.Compound({"Name": nbtlib.String("minecraft:stone")}),
                    nbtlib.Compound(
                        {
                            "Name": nbtlib.String("minecraft:oak_log"),
                            "Properties": nbtlib.Compound({"axis": nbtlib.String("y")}),
                        }
                    ),
                ]
            ),
            "BlockStates": nbtlib.LongArray(packed),
        }
    )

    root = nbtlib.Compound(
        {
            "Regions": nbtlib.Compound(
                {
                    "b-region": region,
                }
            )
        }
    )

    plan = parse_schematic_bytes("build.litematic", _write_nbt(root, "Litematic"))

    assert plan.total_blocks == 2
    assert plan.placements[0].block_id == "minecraft:stone"
    assert (plan.placements[0].dx, plan.placements[0].dy, plan.placements[0].dz) == (-6, 5, 20)
    assert plan.placements[1].block_id == "minecraft:oak_log"
    assert plan.placements[1].block_state == {"axis": "y"}
    assert (plan.placements[1].dx, plan.placements[1].dy, plan.placements[1].dz) == (10, 5, 21)


def test_parse_legacy_schematic() -> None:
    root = nbtlib.Compound(
        {
            "Width": nbtlib.Short(2),
            "Height": nbtlib.Short(1),
            "Length": nbtlib.Short(2),
            "Blocks": nbtlib.ByteArray([1, 35, 4, 0]),
            "Data": nbtlib.ByteArray([0, 14, 0, 0]),
            "AddBlocks": nbtlib.ByteArray([0, 0]),
        }
    )

    plan = parse_schematic_bytes("legacy.schematic", _write_nbt(root, "Schematic"))

    assert plan.total_blocks == 3
    assert [p.block_id for p in plan.placements] == [
        "minecraft:stone",
        "minecraft:red_wool",
        "minecraft:cobblestone",
    ]


def test_unsupported_extension() -> None:
    with pytest.raises(UnsupportedSchematicFormatError):
        parse_schematic_bytes("readme.txt", b"anything")
