/** Multi-view PNG renderer for creative voxel builds. */

import { PNG } from "pngjs";
import type { BlockPlacement } from "../types.js";

type Color = readonly [number, number, number, number];
type Point = readonly [number, number];

const defaultColor: Color = [180, 180, 180, 255];
const palette: Record<string, Color> = {
  "minecraft:stone": [120, 120, 120, 255],
  "minecraft:cobblestone": [104, 104, 104, 255],
  "minecraft:stone_bricks": [128, 128, 128, 255],
  "minecraft:deepslate_bricks": [70, 70, 78, 255],
  "minecraft:oak_planks": [153, 111, 64, 255],
  "minecraft:birch_planks": [206, 192, 140, 255],
  "minecraft:sandstone": [216, 206, 154, 255],
  "minecraft:red_wool": [176, 46, 38, 255],
  "minecraft:blue_wool": [59, 68, 170, 255],
  "minecraft:green_wool": [94, 124, 22, 255],
  "minecraft:yellow_wool": [241, 175, 21, 255],
  "minecraft:purple_wool": [137, 50, 184, 255],
  "minecraft:orange_wool": [224, 97, 0, 255],
  "minecraft:cyan_wool": [22, 156, 156, 255],
  "minecraft:black_wool": [24, 24, 24, 255],
  "minecraft:white_wool": [233, 236, 236, 255],
  "minecraft:glass": [172, 214, 230, 220],
  "minecraft:lantern": [245, 211, 93, 255],
  "minecraft:torch": [255, 178, 48, 255],
  "minecraft:gold_block": [246, 205, 65, 255],
  "minecraft:grass_block": [90, 150, 54, 255],
  "minecraft:dirt": [121, 85, 58, 255],
};

/** Render front, side, top, and isometric views into one transparent PNG. */
export function renderCreativeComposite(blocks: readonly BlockPlacement[]): Buffer {
  const visibleBlocks = blocks.filter((block) => block.blockId !== "minecraft:air");
  if (visibleBlocks.length === 0) {
    return PNG.sync.write(new PNG({ width: 32, height: 32 }));
  }

  const xs = visibleBlocks.map((block) => block.x);
  const ys = visibleBlocks.map((block) => block.y);
  const zs = visibleBlocks.map((block) => block.z);
  const bounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
  const dims = {
    x: bounds.maxX - bounds.minX + 1,
    y: bounds.maxY - bounds.minY + 1,
    z: bounds.maxZ - bounds.minZ + 1,
  };
  const cell = 12;
  const padding = 16;
  const gap = 20;
  const front = { width: dims.x * cell + padding * 2, height: dims.y * cell + padding * 2 };
  const side = { width: dims.z * cell + padding * 2, height: dims.y * cell + padding * 2 };
  const top = { width: dims.x * cell + padding * 2, height: dims.z * cell + padding * 2 };
  const iso = renderIsoPane(visibleBlocks, bounds);
  const canvas = new PNG({
    width: front.width + side.width + gap * 3,
    height: Math.max(front.height + top.height + gap, side.height + top.height + gap, iso.height),
  });

  renderFront(canvas, visibleBlocks, bounds, padding, padding, cell);
  renderSide(canvas, visibleBlocks, bounds, front.width + gap, padding, cell);
  renderTop(canvas, visibleBlocks, bounds, padding, front.height + gap, cell);
  blitPng(canvas, iso.png, front.width + side.width + gap * 2, 0);

  return PNG.sync.write(canvas);
}

function renderFront(canvas: PNG, blocks: readonly BlockPlacement[], bounds: Bounds, originX: number, originY: number, cell: number): void {
  const sorted = [...blocks].sort((left, right) => left.z - right.z || left.y - right.y || left.x - right.x);
  for (const block of sorted) {
    drawRect(
      canvas,
      originX + (block.x - bounds.minX) * cell,
      originY + (bounds.maxY - block.y) * cell,
      cell - 1,
      cell - 1,
      colorFor(block.blockId),
    );
  }
}

function renderSide(canvas: PNG, blocks: readonly BlockPlacement[], bounds: Bounds, originX: number, originY: number, cell: number): void {
  const sorted = [...blocks].sort((left, right) => left.x - right.x || left.y - right.y || left.z - right.z);
  for (const block of sorted) {
    drawRect(
      canvas,
      originX + (block.z - bounds.minZ) * cell,
      originY + (bounds.maxY - block.y) * cell,
      cell - 1,
      cell - 1,
      colorFor(block.blockId),
    );
  }
}

function renderTop(canvas: PNG, blocks: readonly BlockPlacement[], bounds: Bounds, originX: number, originY: number, cell: number): void {
  const sorted = [...blocks].sort((left, right) => left.y - right.y || left.z - right.z || left.x - right.x);
  for (const block of sorted) {
    drawRect(
      canvas,
      originX + (block.x - bounds.minX) * cell,
      originY + (block.z - bounds.minZ) * cell,
      cell - 1,
      cell - 1,
      colorFor(block.blockId),
    );
  }
}

function renderIsoPane(blocks: readonly BlockPlacement[], bounds: Bounds): { png: PNG; width: number; height: number } {
  const tileWidth = 18;
  const tileHeight = 10;
  const cubeHeight = 10;
  const projected = blocks.map((block) => {
    const px = (block.x - bounds.minX - (block.z - bounds.minZ)) * (tileWidth / 2);
    const py = (block.x - bounds.minX + block.z - bounds.minZ) * (tileHeight / 2) - (block.y - bounds.minY) * cubeHeight;
    return { block, px, py };
  });
  const minX = Math.min(...projected.map((entry) => entry.px - tileWidth / 2));
  const maxX = Math.max(...projected.map((entry) => entry.px + tileWidth / 2));
  const minY = Math.min(...projected.map((entry) => entry.py));
  const maxY = Math.max(...projected.map((entry) => entry.py + tileHeight + cubeHeight));
  const padding = 18;
  const width = Math.ceil(maxX - minX + padding * 2);
  const height = Math.ceil(maxY - minY + padding * 2);
  const png = new PNG({ width, height });
  const sorted = [...projected].sort((left, right) =>
    (left.block.x + left.block.z + left.block.y) - (right.block.x + right.block.z + right.block.y),
  );

  for (const entry of sorted) {
    const color = colorFor(entry.block.blockId);
    const ox = Math.round(entry.px - minX + padding);
    const oy = Math.round(entry.py - minY + padding);
    drawIsoCube(png, ox, oy, tileWidth, tileHeight, cubeHeight, color);
  }

  return { png, width, height };
}

type Bounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

function drawRect(png: PNG, x: number, y: number, width: number, height: number, color: Color): void {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      setPixel(png, px, py, color);
    }
  }
}

function drawIsoCube(png: PNG, x: number, y: number, tileWidth: number, tileHeight: number, cubeHeight: number, color: Color): void {
  const top = [
    [x, y],
    [x + tileWidth / 2, y + tileHeight / 2],
    [x, y + tileHeight],
    [x - tileWidth / 2, y + tileHeight / 2],
  ] as Point[];
  const left = [
    [x - tileWidth / 2, y + tileHeight / 2],
    [x, y + tileHeight],
    [x, y + tileHeight + cubeHeight],
    [x - tileWidth / 2, y + tileHeight / 2 + cubeHeight],
  ] as Point[];
  const right = [
    [x + tileWidth / 2, y + tileHeight / 2],
    [x, y + tileHeight],
    [x, y + tileHeight + cubeHeight],
    [x + tileWidth / 2, y + tileHeight / 2 + cubeHeight],
  ] as Point[];
  fillPolygon(png, top, color);
  fillPolygon(png, left, shade(color, 0.82));
  fillPolygon(png, right, shade(color, 0.68));
}

function fillPolygon(png: PNG, points: readonly Point[], color: Color): void {
  const minY = Math.floor(Math.min(...points.map((point) => point[1])));
  const maxY = Math.ceil(Math.max(...points.map((point) => point[1])));

  for (let y = minY; y <= maxY; y += 1) {
    const intersections: number[] = [];

    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      const [x1, y1] = current;
      const [x2, y2] = next;
      const crosses = (y1 <= y && y2 > y) || (y2 <= y && y1 > y);
      if (!crosses) {
        continue;
      }
      intersections.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }

    intersections.sort((left, right) => left - right);
    for (let index = 0; index < intersections.length; index += 2) {
      const start = Math.round(intersections[index]!);
      const end = Math.round(intersections[index + 1]!);
      for (let x = start; x <= end; x += 1) {
        setPixel(png, x, y, color);
      }
    }
  }
}

function shade(color: Color, factor: number): Color {
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor),
    color[3],
  ];
}

function blitPng(target: PNG, source: PNG, x: number, y: number): void {
  for (let py = 0; py < source.height; py += 1) {
    for (let px = 0; px < source.width; px += 1) {
      const srcIndex = (source.width * py + px) << 2;
      const alpha = source.data[srcIndex + 3]!;
      if (alpha === 0) {
        continue;
      }
      const destIndex = (target.width * (y + py) + (x + px)) << 2;
      target.data[destIndex] = source.data[srcIndex]!;
      target.data[destIndex + 1] = source.data[srcIndex + 1]!;
      target.data[destIndex + 2] = source.data[srcIndex + 2]!;
      target.data[destIndex + 3] = alpha;
    }
  }
}

function setPixel(png: PNG, x: number, y: number, color: Color): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }
  const index = (png.width * Math.floor(y) + Math.floor(x)) << 2;
  png.data[index] = color[0];
  png.data[index + 1] = color[1];
  png.data[index + 2] = color[2];
  png.data[index + 3] = color[3];
}

function colorFor(blockId: string): Color {
  return palette[blockId] ?? defaultColor;
}
