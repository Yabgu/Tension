// tension-framework/tests/guest-font-specimen.ts — the baked outlines, on screen.
//
// This is the test that answers "does the TTF actually look like text", which no
// arithmetic assertion can. It draws a specimen page — the same strings at 14 px
// and 18 px Inter and 14 px JetBrains Mono, a heading per band, a clipped
// paragraph and a strip of chrome — then reads the frame back and writes it out
// as raw RGBA for the runner to encode as a PNG.
//
// ## What is asserted, and why each one can fail
//
//   * **Three pages exist** and their geometry is coherent (a baseline inside the
//     cell, a line pitch taller than the ink box). A page whose baseline sat
//     outside its cell would draw every glyph shifted, which reads as "the font
//     is broken".
//   * **Proportional and monospace are measured, not claimed.**
//     `advance('i') < advance('W')` is false for every monospace face; "all 95
//     printable characters advance the same" is true only for one. Together they
//     distinguish "we baked Inter" from "we baked one font three times".
//   * **Ink lands in the band it was asked for.** Each band records its own
//     top and rule-y as it draws, and the test asserts ink inside the band and
//     none in the gutter below it. A shifted page still draws *something*, so a
//     total-pixel count would pass; a band check would not.
//   * **`pushClip`/`popClip` clip and restore.** Three lines are drawn through a
//     two-line clip; the third must not appear below the clip's bottom edge,
//     while a line drawn *after* the pop, at the same y but a different x, must.
//     Either half alone is passable by a broken implementation: "nothing drawn"
//     passes the first, "clip ignored" passes the second.
//
// The frame is written rather than compared pixel-for-pixel: a rendering change
// is a thing a person looks at, and the specimen exists so they can. The counts
// are the machine's half.
//
// The runner supplies the atlas (`--res <packed assets>`) and a place to write
// (`--write-root <dir>`). `CANVAS_W`/`CANVAS_H`/`OUT_NAME` are shared with
// `scripts/test-framework.mjs`.

import { Canvas } from "../assembly/2d/canvas";
import { Pixels } from "../assembly/2d/buffers";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { Bytes } from "../assembly/bytes";
import { resWriteFile } from "../assembly/res";
import { Painter } from "../assembly/ui/painter";
import { Chrome, FontBook, loadFontBook } from "../assembly/ui/fonts";
import { FONT_INTER, FONT_MONO, SIZE_14, SIZE_18 } from "../assembly/ui/fonts.generated";
import { BOLD, HEADING, LINK, MUTED, NORMAL, REGULAR } from "../assembly/ui/theme";

/** The frame's size. Shared with the runner, which needs it to encode the PNG. */
const CANVAS_W: i32 = 720;
const CANVAS_H: i32 = 420;
/** The file the raw frame is written to, relative to the runner's `--write-root`. */
const OUT_NAME: string = "font-specimen.rgba";

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) failures++;
  print((ok ? "  ok: " : "  FAIL: ") + what);
}

function checkEq(want: i32, got: i32, what: string): void {
  if (want != got) failures++;
  print((want == got ? "  ok: " : "  FAIL: ") + what + " (want " + want.toString() +
        ", got " + got.toString() + ")");
}

/** UTF-8 bytes of a literal — the painter takes bytes, not strings. */
function bytesOf(text: string): Uint8Array {
  return Uint8Array.wrap(String.UTF8.encode(text, false));
}

// ── the drawing ─────────────────────────────────────────────────────────────

/// Where each band drew, so the pixel assertions do not have to re-derive it.
class Bands {
  /** `4 * n` entries: top, ruleY, inkBottom for each band, padded with 0s. */
  tops: i32[] = [];
  rules: i32[] = [];
  count: i32 = 0;

  add(top: i32, ruleY: i32): void {
    this.tops.push(top);
    this.rules.push(ruleY);
    this.count++;
  }
}

/**
 * One band: a label, then `lines` of body text, then a hairline.
 *
 * Returns the y the next band starts at. The band's own geometry is recorded so
 * the caller's assertions use the draw's numbers rather than a second copy of
 * the arithmetic — the mistake `hit.ts` exists to prevent.
 */
function band(p: Painter, bands: Bands, book: FontBook, family: i32, size: i32,
              label: string, lines: string[], y: i32): i32 {
  const page = book.page(family, size);
  const heading = bytesOf(label);

  p.textBytes(heading, 0, i32(heading.length), 24, y, HEADING, BOLD, page.cellW,
              0, CANVAS_H, page);

  let ly: i32 = y + page.lineStep;
  for (let i: i32 = 0; i < lines.length; i++) {
    const line = bytesOf(lines[i]);
    p.textBytes(line, 0, i32(line.length), 24, ly, NORMAL, REGULAR, page.cellW,
                0, CANVAS_H, page);
    ly += page.lineStep;
  }
  p.hline(24, ly, CANVAS_W - 48, page.chromeCell(Chrome.Divider), page);
  bands.add(y, ly);
  return ly + 12;
}

/** The y the clip runs at, recorded for the pixel assertions. */
let clipTop: i32 = 0;
let clipH: i32 = 0;
/** The x the after-pop line is drawn at, deliberately past the clipped column. */
const AFTER_POP_X: i32 = 400;

function drawSpecimen(p: Painter, book: FontBook, bands: Bands): void {
  let y: i32 = 12;

  y = band(p, bands, book, FONT_INTER, SIZE_14,
           "Inter 14 regular - proportional text", [
    "Handgloves 0123456789 - the quick brown fox jumps",
    "over the lazy dog, then does it again in 14 px.",
  ], y);

  y = band(p, bands, book, FONT_INTER, SIZE_18,
           "Inter 18 regular - the body size", [
    "Handgloves 0123456789 - the quick brown fox",
    "jumps over the lazy dog, at eighteen pixels.",
  ], y);

  y = band(p, bands, book, FONT_MONO, SIZE_14,
           "JetBrains Mono 14 - code", [
    "fn bake(atlas: &mut Atlas) -> Result<()> {",
    "    atlas.page(0).cell(570, CHROME_PANEL);",
    "}",
  ], y);

  // ── the clip stack ──────────────────────────────────────────────────────
  //
  // Three lines through a clip tall enough for two. The third lands exactly on
  // the clip's bottom edge, in the same row as the line drawn after the pop —
  // so only the x ranges tell them apart, which is what makes both halves of the
  // property testable at once.
  const mono = book.page(FONT_MONO, SIZE_14);
  const label = bytesOf("clipped: 3 lines through a 2-line clip");
  p.textBytes(label, 0, i32(label.length), 24, y, MUTED, REGULAR, mono.cellW,
              0, CANVAS_H, mono);

  clipTop = y + mono.lineStep;
  clipH = mono.lineStep * 2;
  p.pushClip(24, clipTop, 340, clipH);
  const marks: string[] = ["clipped line one", "clipped line two", "clipped line three"];
  let cy: i32 = clipTop;
  for (let i: i32 = 0; i < marks.length; i++) {
    const line = bytesOf(marks[i]);
    p.textBytes(line, 0, i32(line.length), 24, cy, NORMAL, REGULAR, mono.cellW,
                0, CANVAS_H, mono);
    cy += mono.lineStep;
  }
  p.popClip();

  // The same row as the suppressed third line, but outside the clipped column:
  // if this is missing the clip never restored, and if the third line shows the
  // clip never applied.
  const after = bytesOf("after popClip - still drawing");
  p.textBytes(after, 0, i32(after.length), AFTER_POP_X, clipTop + clipH, LINK, REGULAR,
              mono.cellW, 0, CANVAS_H, mono);

  // A selection block behind a label: a solid chrome cell from the same page,
  // drawn before the text so the alpha blend puts the glyphs on top of it.
  const selY: i32 = clipTop + clipH + mono.lineStep * 2;
  p.fill(20, selY - 2, 260, mono.cellH + 4, mono.chromeCell(Chrome.Selection), mono);
  const sel = bytesOf("selection over chrome");
  p.textBytes(sel, 0, i32(sel.length), 24, selY, HEADING, REGULAR, mono.cellW,
              0, CANVAS_H, mono);
}

// ── the advance assertions ──────────────────────────────────────────────────

function checkAdvances(book: FontBook): void {
  const ui14 = book.page(FONT_INTER, SIZE_14);
  const ui18 = book.page(FONT_INTER, SIZE_18);
  const mono = book.page(FONT_MONO, SIZE_14);

  checkEq(3, book.count, "the atlas carries three pages");
  checkEq(FONT_INTER, ui14.family, "page 0 is the UI face");
  checkEq(14, ui14.sizePx, "at 14 px");
  checkEq(18, ui18.sizePx, "page 1 is 18 px");
  checkEq(FONT_MONO, mono.family, "page 2 is the mono face");

  for (let i: i32 = 0; i < book.count; i++) {
    const page = book.pages[i];
    check(page.baseline > 0 && page.baseline < page.cellH,
          "page " + i.toString() + ": baseline " + page.baseline.toString() +
          " inside a " + page.cellH.toString() + "px cell");
    check(page.lineStep > page.cellH,
          "page " + i.toString() + ": a line (" + page.lineStep.toString() +
          ") is taller than its ink box (" + page.cellH.toString() + ")");
    check(page.cellW > 0 && page.gridCols > 0, "page " + i.toString() + ": has a grid");
    check(page.chromeCell(Chrome.Panel) >= page.glyphCells,
          "page " + i.toString() + ": chrome sits past the glyph stripes");
  }

  // Proportional: Inter's 'i' is much narrower than its 'W'.
  const iAdv = ui14.advanceQ(REGULAR, 105);   // 'i'
  const wAdv = ui14.advanceQ(REGULAR, 87);    // 'W'
  check(iAdv < wAdv, "Inter 14 'i' (" + iAdv.toString() + ") is narrower than 'W' (" +
        wAdv.toString() + ")  [quarter-px]");

  // Monospace: every printable character advances the same.
  let uniform: bool = true;
  const first: i32 = mono.advanceQ(REGULAR, 33);
  for (let code: i32 = 33; code <= 126; code++) {
    if (mono.advanceQ(REGULAR, code) != first) uniform = false;
  }
  check(uniform, "JetBrains Mono advances every glyph identically (" + first.toString() +
        " quarter-px = " + mono.advancePx(REGULAR, 65).toString() + " px)");

  // A size is a bake, not a scale.
  check(ui18.advanceQ(REGULAR, 87) > ui14.advanceQ(REGULAR, 87),
        "Inter 18 'W' is wider than Inter 14 'W'");

  // Measurement follows the table.
  const hello = bytesOf("Hello, world");
  const w14 = book.measure(ui14, REGULAR, hello, 0, i32(hello.length));
  const w18 = book.measure(ui18, REGULAR, hello, 0, i32(hello.length));
  const wMono = book.measure(mono, REGULAR, hello, 0, i32(hello.length));
  print("  measured \"Hello, world\": 14px " + w14.toString() + "px, 18px " +
        w18.toString() + "px, mono " + wMono.toString() + "px");
  check(w18 > w14, "the same string is wider at 18 px (" + w14.toString() + " < " +
        w18.toString() + ")");
  check(w14 > 0 && w14 < CANVAS_W, "and fits the frame");

  // A pair the bake did not include must be a *missing stripe*, not a neighbour's
  // glyph: -1 means the painter draws nothing.
  checkEq(-1, ui14.cellOf(LINK, BOLD, 65), "an unbaked pair is refused, not mis-sampled");
  check(ui14.cellOf(NORMAL, REGULAR, 65) >= 0, "a baked pair resolves to a cell");
}

// ── the frame ───────────────────────────────────────────────────────────────

/// Copy the frame out as raw RGBA.
///
/// `Pixels` deliberately hands out no address (`buffers.ts`), so this goes
/// through `byteAt` — 1.2 million bounds-checked reads, once, in a test.
function writeFrame(pixels: Pixels, out: Bytes): void {
  const total: i32 = pixels.byteLength();
  for (let i: i32 = 0; i < total; i++) out.setByteAt(i, pixels.byteAt(i));
}

export function _start_game(): void {
  print("=== font specimen: baked TTF outlines through tension::2d ===");

  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("SPECIMEN FAIL: the session did not open");
    return;
  }

  const canvas = Canvas.open(CANVAS_W, CANVAS_H);
  if (!canvas.isValid()) {
    print("SPECIMEN FAIL: canvas open -> " + canvas.lastError().toString());
    RuntimeSession.close();
    return;
  }

  const pipe = canvas.pipeline();
  if (pipe < 0) {
    print("SPECIMEN FAIL: set_pipeline -> " + pipe.toString());
    canvas.close();
    RuntimeSession.close();
    return;
  }

  const loaded = loadFontBook(canvas, pipe);
  if (loaded != 0) {
    print("SPECIMEN FAIL: loading the atlas -> " + loaded.toString() +
          " (the runner must mount the baked assets with --res)");
    canvas.close();
    RuntimeSession.close();
    return;
  }

  const book = new FontBook();
  checkAdvances(book);

  const bands = new Bands();
  const painter = new Painter(book.pages[0]);
  drawSpecimen(painter, book, bands);
  print("  drew " + painter.count.toString() + " records" +
        (painter.dropped > 0 ? " (" + painter.dropped.toString() + " dropped)" : ""));

  const submitted = painter.submit(canvas, pipe);
  if (submitted < 0) {
    print("SPECIMEN FAIL: submit -> " + submitted.toString());
    canvas.close();
    RuntimeSession.close();
    return;
  }
  const presented = canvas.present();
  if (presented != 0) {
    print("SPECIMEN FAIL: present -> " + presented.toString());
    canvas.close();
    RuntimeSession.close();
    return;
  }

  const pixels = Pixels.create(CANVAS_W, CANVAS_H);
  const read = canvas.screenshot(pixels);
  if (read <= 0) {
    print("SPECIMEN FAIL: screenshot -> " + read.toString());
    canvas.close();
    RuntimeSession.close();
    return;
  }

  // ── what the pixels say ─────────────────────────────────────────────────
  const total = pixels.nonBlack();
  check(total > 1000, "the frame has ink (" + total.toString() + " non-black pixels)");

  // Every band drew; the gutter between two bands is empty. The gutter is the
  // pixels below one band's rule and above the next band's label.
  for (let i: i32 = 0; i < bands.count; i++) {
    const top = bands.tops[i];
    const rule = bands.rules[i];
    const ink = pixels.nonBlackIn(16, top, CANVAS_W - 32, rule - top);
    check(ink > 0, "band " + i.toString() + " (y " + top.toString() + ".." +
          rule.toString() + ") carries " + ink.toString() + " non-black pixels");
    if (i > 0) {
      const gutterTop = bands.rules[i - 1] + 2;
      const gutter = pixels.nonBlackIn(16, gutterTop, CANVAS_W - 32, top - gutterTop);
      checkEq(0, gutter, "the gutter before band " + i.toString() + " is empty");
    }
  }

  // The clip: the third line must not appear below the clip's bottom edge, and
  // the line drawn after the pop must.
  const suppressed = pixels.nonBlackIn(24, clipTop + clipH, 340, 6);
  const restored = pixels.nonBlackIn(AFTER_POP_X - 4, clipTop + clipH, 300, 20);
  checkEq(0, suppressed, "the clipped third line did not draw past the clip");
  check(restored > 0, "the line after popClip drew (" + restored.toString() +
        " non-black pixels)");

  // ── write the frame out ─────────────────────────────────────────────────
  const out = Bytes.allocate(CANVAS_W * CANVAS_H * 4);
  writeFrame(pixels, out);
  const wrote = resWriteFile(OUT_NAME, out);
  check(wrote > 0, "wrote " + OUT_NAME + " (" + wrote.toString() + " bytes)");

  print(failures == 0 ? "OK" : "SPECIMEN FAIL: " + failures.toString() + " check(s)");

  canvas.close();
  RuntimeSession.close();
}
