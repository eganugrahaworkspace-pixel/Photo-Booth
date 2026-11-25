import test from "node:test";
import assert from "node:assert/strict";
import { COLLAGE_AREA, COLLAGE_GAP, cellSourceRect, collageCells, countdownFor, parseMode, type Cell, type Mode } from "../src/collage.ts";

const MODES: Mode[] = [2, 4, 6];

test("mode 1 memakai seluruh bingkai", () => {
  assert.deepEqual(collageCells(1), [{ x: 0, y: 0, w: 1080, h: 1920 }]);
});

test("jumlah sel sesuai mode", () => {
  assert.equal(collageCells(1).length, 1);
  assert.equal(collageCells(2).length, 2);
  assert.equal(collageCells(4).length, 4);
  assert.equal(collageCells(6).length, 6);
});

test("sel berada di dalam area kolase dan tidak bertumpuk", () => {
  const inside = (c: Cell) =>
    c.x >= COLLAGE_AREA.x &&
    c.y >= COLLAGE_AREA.y &&
    c.x + c.w <= COLLAGE_AREA.x + COLLAGE_AREA.w &&
    c.y + c.h <= COLLAGE_AREA.y + COLLAGE_AREA.h;
  for (const mode of MODES) {
    const cells = collageCells(mode);
    for (const c of cells) assert.ok(inside(c), `mode ${mode}: sel ${JSON.stringify(c)} keluar area`);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
        const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!(overlapX && overlapY), `mode ${mode}: sel ${i} dan ${j} bertumpuk`);
        // Neighbouring cells sit side by side or stacked, so the gap is measured on the axis that separates them.
        const gapX = overlapY ? Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)) : Infinity;
        const gapY = overlapX ? Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)) : Infinity;
        const gap = Math.min(gapX, gapY);
        if (gap !== Infinity) assert.ok(gap >= COLLAGE_GAP - 1, `mode ${mode}: celah ${gap} terlalu kecil`);
      }
    }
  }
});

test("mode 6 berbentuk 2 kolom 3 baris", () => {
  const cells = collageCells(6);
  assert.equal(new Set(cells.map((c) => c.x)).size, 2);
  assert.equal(new Set(cells.map((c) => c.y)).size, 3);
});

test("parseMode menolak nilai asing", () => {
  assert.equal(parseMode("3"), 1);
  assert.equal(parseMode("abc"), 1);
  assert.equal(parseMode(undefined), 1);
  assert.equal(parseMode(0), 1);
  assert.equal(parseMode("4"), 4);
  assert.equal(parseMode(2), 2);
});

test("hitungan foto pertama 3-2-1, berikutnya 2-1", () => {
  assert.deepEqual(countdownFor(0), [3, 2, 1]);
  assert.deepEqual(countdownFor(1), [2, 1]);
  assert.deepEqual(countdownFor(5), [2, 1]);
});

test("ukuran sel bilangan bulat dan sel terakhir di tepi area", () => {
  for (const mode of MODES) {
    const cells = collageCells(mode);
    for (const c of cells) {
      for (const v of [c.x, c.y, c.w, c.h]) assert.ok(Number.isInteger(v), `mode ${mode}: nilai ${v} bukan bilangan bulat`);
    }
    const last = cells[cells.length - 1];
    assert.ok(Math.abs(last.x + last.w - (COLLAGE_AREA.x + COLLAGE_AREA.w)) <= 1, `mode ${mode}: tepi kanan`);
    assert.ok(Math.abs(last.y + last.h - (COLLAGE_AREA.y + COLLAGE_AREA.h)) <= 1, `mode ${mode}: tepi bawah`);
  }
});

test("sel diambil dari area yang terlihat di pratinjau", () => {
  const EPS = 1e-6;
  // Preview region for a 1920x1080 source in a 9:16 frame: the centre 607.5 px wide strip.
  const region = { x0: 656.25, y0: 0, x1: 656.25 + 607.5, y1: 1080 };
  for (const mode of [1, 2, 4, 6] as Mode[]) {
    for (const cell of collageCells(mode)) {
      const r = cellSourceRect(1920, 1080, cell, 1080, 1920);
      assert.ok(r.sx >= region.x0 - EPS && r.sx + r.sw <= region.x1 + EPS, `mode ${mode}: keluar area lebar pratinjau`);
      assert.ok(r.sy >= region.y0 - EPS && r.sy + r.sh <= region.y1 + EPS, `mode ${mode}: keluar area tinggi pratinjau`);
    }
  }
  // 1080x1920 source: mode 2 cell spans the full width and is vertically centred.
  const [cell] = collageCells(2);
  const r = cellSourceRect(1080, 1920, cell, 1080, 1920);
  assert.equal(r.sw, 1080);
  assert.ok(Math.abs(r.sy * 2 + r.sh - 1920) < EPS, "tidak berpusat vertikal");
});
