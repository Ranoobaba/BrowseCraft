/** Geometry primitives used by the JS voxel DSL and by testable Node-side helpers. */

import type { BlockPlacement } from "../types.js";

export type CylinderAxis = "x" | "y" | "z";

/** Return one block placement. */
export function singleBlockPlacement(x: number, y: number, z: number, blockId: string): BlockPlacement[] {
  return [{ x, y, z, blockId }];
}

/** Return the inclusive cuboid placements for a box primitive. */
export function boxPlacements(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  blockId: string,
): BlockPlacement[] {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  const placements: BlockPlacement[] = [];

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        placements.push({ x, y, z, blockId });
      }
    }
  }

  return placements;
}

/** Return a 3D Bresenham line. */
export function linePlacements(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  blockId: string,
): BlockPlacement[] {
  const placements: BlockPlacement[] = [];
  let x = x1;
  let y = y1;
  let z = z1;
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const dz = Math.abs(z2 - z1);
  const xs = x2 > x1 ? 1 : -1;
  const ys = y2 > y1 ? 1 : -1;
  const zs = z2 > z1 ? 1 : -1;

  placements.push({ x, y, z, blockId });

  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx;
    let p2 = 2 * dz - dx;
    while (x !== x2) {
      x += xs;
      if (p1 >= 0) {
        y += ys;
        p1 -= 2 * dx;
      }
      if (p2 >= 0) {
        z += zs;
        p2 -= 2 * dx;
      }
      p1 += 2 * dy;
      p2 += 2 * dz;
      placements.push({ x, y, z, blockId });
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy;
    let p2 = 2 * dz - dy;
    while (y !== y2) {
      y += ys;
      if (p1 >= 0) {
        x += xs;
        p1 -= 2 * dy;
      }
      if (p2 >= 0) {
        z += zs;
        p2 -= 2 * dy;
      }
      p1 += 2 * dx;
      p2 += 2 * dz;
      placements.push({ x, y, z, blockId });
    }
  } else {
    let p1 = 2 * dy - dz;
    let p2 = 2 * dx - dz;
    while (z !== z2) {
      z += zs;
      if (p1 >= 0) {
        y += ys;
        p1 -= 2 * dz;
      }
      if (p2 >= 0) {
        x += xs;
        p2 -= 2 * dz;
      }
      p1 += 2 * dy;
      p2 += 2 * dx;
      placements.push({ x, y, z, blockId });
    }
  }

  return placements;
}

/** Return filled or hollow sphere placements. */
export function spherePlacements(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  blockId: string,
  hollow = false,
): BlockPlacement[] {
  const placements: BlockPlacement[] = [];
  const innerRadiusSquared = Math.max(radius - 1, 0) ** 2;
  const outerRadiusSquared = radius ** 2;

  for (let x = cx - radius; x <= cx + radius; x += 1) {
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let z = cz - radius; z <= cz + radius; z += 1) {
        const distanceSquared = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
        if (distanceSquared > outerRadiusSquared) {
          continue;
        }
        if (hollow && radius > 1 && distanceSquared < innerRadiusSquared) {
          continue;
        }
        placements.push({ x, y, z, blockId });
      }
    }
  }

  return placements;
}

/** Return a filled cylinder aligned to one axis. */
export function cylinderPlacements(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  height: number,
  blockId: string,
  axis: CylinderAxis = "y",
): BlockPlacement[] {
  const placements: BlockPlacement[] = [];
  const radiusSquared = radius ** 2;

  for (let offset = 0; offset < height; offset += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if ((dx ** 2) + (dz ** 2) > radiusSquared) {
          continue;
        }
        if (axis === "y") {
          placements.push({ x: cx + dx, y: cy + offset, z: cz + dz, blockId });
        } else if (axis === "x") {
          placements.push({ x: cx + offset, y: cy + dx, z: cz + dz, blockId });
        } else {
          placements.push({ x: cx + dx, y: cy + dz, z: cz + offset, blockId });
        }
      }
    }
  }

  return placements;
}
