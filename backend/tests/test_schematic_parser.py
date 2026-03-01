from __future__ import annotations

from pathlib import Path

import nbtlib

from browsecraft_backend.schematic_parser import parse_schematic


def test_parse_sponge_schem_returns_relative_placements(tmp_path: Path) -> None:
    root = nbtlib.Compound(
        {
            "Version": nbtlib.Int(3),
            "Width": nbtlib.Short(2),
            "Height": nbtlib.Short(1),
            "Length": nbtlib.Short(2),
            "PaletteMax": nbtlib.Int(2),
            "Palette": nbtlib.Compound(
                {
                    "minecraft:air": nbtlib.Int(0),
                    "minecraft:stone": nbtlib.Int(1),
                }
            ),
            "BlockData": nbtlib.ByteArray([1, 0, 1, 0]),
        }
    )
    file = nbtlib.File(root)
    schem_path = tmp_path / "sample.schem"
    file.save(schem_path, gzipped=True)

    placements = parse_schematic(schem_path)

    assert placements == [
        {"dx": 0, "dy": 0, "dz": 0, "block_id": "minecraft:stone", "block_state": {}},
        {"dx": 0, "dy": 0, "dz": 1, "block_id": "minecraft:stone", "block_state": {}},
    ]
