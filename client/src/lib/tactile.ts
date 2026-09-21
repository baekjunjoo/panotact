/**
 * Tactile finishing + structural diagnostics for the 60x40 grid.
 *
 * Ported from the (Python) DotPad conversion engine, where every rule here was measured against 65 hand-made
 * reference graphics. The premise everything below follows: **a fingertip cannot feel a diagonal-only join.**
 * Two dots touching only at a corner are one line to the eye and two separate lines to the finger, so
 * connectivity is 4-way (up/down/left/right) everywhere in this file.
 *
 * What the measurements found, and what this port carries over:
 *  - hand-made pages average 14.4 four-connected pieces; raw machine output was 55+ until diagonal steps were
 *    bridged (`bridge4`) — after which the engine landed at human-level structure.
 *  - the original engine's '/' -diagonal branch was a silent no-op for months (it wrote back a cell its own
 *    condition required to be set). Both diagonals are handled here, and `__test__` pins that.
 *  - pruning dead-end twigs must run BEFORE bridging (bridging gives a twig a second neighbour, after which it
 *    no longer looks like a tip), and again after for anything bridging exposed.
 *  - "does the outline enclose anything?" is the defect every score missed: 58% of machine pages had an outline
 *    that enclosed nothing (hand-made: 6%). `pageMetrics` makes it visible per page.
 *
 * Isolated single dots are left alone throughout: they are texture, not noise.
 */

export type Grid = boolean[][]; // grid[y][x], HEIGHT rows of WIDTH

export const TACTILE_WIDTH = 60;
export const TACTILE_HEIGHT = 40;

function size(grid: Grid) {
  return { height: grid.length, width: grid[0]?.length ?? 0 };
}

function copy(grid: Grid): Grid {
  return grid.map((row) => row.slice());
}

/** Make every 8-connected diagonal step 4-connected by filling one empty corner of its 2x2 block. Adds dots only. */
export function bridge4(grid: Grid): Grid {
  const { height, width } = size(grid);
  const g = copy(grid);
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      if (g[y][x] && g[y + 1][x + 1] && !g[y][x + 1] && !g[y + 1][x]) g[y][x + 1] = true; // '\' step
      if (g[y][x + 1] && g[y + 1][x] && !g[y][x] && !g[y + 1][x + 1]) g[y][x] = true; // '/' step
    }
  }
  return g;
}

function neighbours4(g: Grid, x: number, y: number): Array<[number, number]> {
  const { height, width } = size(g);
  const out: Array<[number, number]> = [];
  if (y > 0 && g[y - 1][x]) out.push([x, y - 1]);
  if (y < height - 1 && g[y + 1][x]) out.push([x, y + 1]);
  if (x > 0 && g[y][x - 1]) out.push([x - 1, y]);
  if (x < width - 1 && g[y][x + 1]) out.push([x + 1, y]);
  return out;
}

function neighbours8(g: Grid, x: number, y: number): Array<[number, number]> {
  const { height, width } = size(g);
  const out: Array<[number, number]> = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && g[ny][nx]) out.push([nx, ny]);
    }
  }
  return out;
}

/**
 * Remove dead-end twigs shorter than `minLength`: from each tip, walk inward while the path stays degree-2; a
 * short walk that ends before a junction is a twig and is removed whole. Real bridges and antennae survive
 * because they reach a junction or are long enough. Isolated dots (degree 0) are never touched.
 *
 * NOTE: tips and the walk are 8-connected on purpose, unlike everything else in this file. A twig hanging off an
 * outline by a diagonal is still a twig, and a raw 8-connected curve (pre-bridge4) must NOT read as a chain of
 * tips — the 4-connected reading would peel a whole circle. This mirrors the Python engine exactly.
 */
export function pruneSpurs(grid: Grid, minLength = 3, maxPasses = 6): Grid {
  const g = copy(grid);
  const { height, width } = size(g);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let removed = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!g[y][x] || neighbours8(g, x, y).length !== 1) continue;
        const path: Array<[number, number]> = [[x, y]];
        let prev: [number, number] | null = null;
        let cur: [number, number] = [x, y];
        while (path.length <= minLength) {
          const next = neighbours8(g, cur[0], cur[1]).filter(([nx, ny]) => !prev || nx !== prev[0] || ny !== prev[1]);
          if (next.length !== 1) break; // junction (or dead end): the branch ends here, junction never appended
          prev = cur;
          cur = next[0];
          path.push(cur);
        }
        if (path.length <= minLength) {
          for (const [rx, ry] of path) g[ry][rx] = false;
          removed += 1;
        }
      }
    }
    if (!removed) break;
  }
  return g;
}

/**
 * The finishing pass a generated page goes through before a reader's finger does: prune stray twigs, make every
 * diagonal step traceable (4-connected), prune whatever the bridging exposed. Order is load-bearing — see above.
 */
export function repairTactile(grid: Grid, spurLength = 3): Grid {
  let g = grid;
  if (spurLength > 0) g = pruneSpurs(g, spurLength);
  g = bridge4(g);
  if (spurLength > 0) g = pruneSpurs(g, spurLength);
  return g;
}

export type TactileMetrics = {
  dots: number;
  /** 4-connected pieces. Hand-made references average 14.4 per page; a big number means a shattered drawing. */
  cc4: number;
  /** Dots with exactly one 4-neighbour — lines that just stop. Hand-made: ~3 per page. */
  looseEnds: number;
  /** True when the largest piece encloses nothing: a finger tracing the outline leaks out of the figure. */
  openMain: boolean;
  /** Enclosed interior as a share of the drawing's bounding box. Hand-made: ~0.38. */
  enclosedRatio: number;
};

/**
 * Structural numbers for one page. Foreground connectivity is 4-way, so the background must be 8-way (digital
 * topology's pairing — otherwise the same picture is both a closed curve and not one). Practically: an outline
 * whose only join somewhere is a diagonal step counts as OPEN, because that is the join the finger fails at.
 */
export function pageMetrics(grid: Grid): TactileMetrics {
  const { height, width } = size(grid);
  let dots = 0;
  let looseEnds = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  const label = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!grid[y][x]) continue;
      dots += 1;
      if (neighbours4(grid, x, y).length === 1) looseEnds += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (label[y * width + x] !== -1) continue;
      const id = sizes.length;
      let count = 0;
      const stack: Array<[number, number]> = [[x, y]];
      label[y * width + x] = id;
      while (stack.length) {
        const [sx, sy] = stack.pop()!;
        count += 1;
        for (const [nx, ny] of neighbours4(grid, sx, sy)) {
          if (label[ny * width + nx] === -1) {
            label[ny * width + nx] = id;
            stack.push([nx, ny]);
          }
        }
      }
      sizes.push(count);
    }
  }

  if (!dots) return { dots: 0, cc4: 0, looseEnds: 0, openMain: true, enclosedRatio: 0 };

  // largest piece = "the figure"; flood the background 8-connected from the border; what neither reaches is enclosed
  let mainId = 0;
  for (let i = 1; i < sizes.length; i += 1) if (sizes[i] > sizes[mainId]) mainId = i;
  const reached = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (!reached[i] && label[i] !== mainId) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) push(nx, ny);
      }
    }
  }
  let enclosed = 0;
  for (let i = 0; i < width * height; i += 1) if (!reached[i] && label[i] !== mainId) enclosed += 1;
  const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);

  return {
    dots,
    cc4: sizes.length,
    looseEnds,
    openMain: enclosed === 0,
    enclosedRatio: bboxArea ? enclosed / bboxArea : 0,
  };
}

/** Parity vectors against the Python engine (tests + dev console). Kept tiny; tree-shaken out of production use. */
export const __test__ = { bridge4, pruneSpurs, repairTactile, pageMetrics };
