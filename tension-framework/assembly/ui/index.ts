// `tension-ui`: the toolkit a Tension guest draws a UI with.
//
// ## The pieces
//
//   * `theme.ts`   what an atlas is — cell size, colour stripes, chrome cells.
//   * `painter.ts` sprite records: rectangles, rules, glyphs, with a clip.
//   * `flow.ts`    where lines end: wrapping, column counts, centring.
//   * `widget.ts`  the four shapes every panel is made of.
//   * `hit.ts`     click targets, recorded by the draw that produced them.
//
// ## The three rules that make it work at this size
//
// 1. **Nothing is tinted and nothing is stretched.** A record has one `w`/`h`
//    pair, used for the destination quad *and* the source texel rect, so a
//    coloured glyph has to be a coloured glyph in the atlas and a panel is tiled
//    from cells rather than scaled (`theme.ts` records both measurements).
// 2. **Black is the background.** The renderer clears to opaque black, and a
//    full-window fill costs the whole 4,096-record budget, so a UI is lines and
//    text on black — panels draw their edges, not their interiors.
// 3. **The draw records the hit targets.** A hit test that recomputes positions
//    is a second layout, and the two drift (`hit.ts`).
//
// Usage, in an `AppShell` (`tension-framework/assembly/app/shell.ts`):
//
//     loadAssets(canvas: Canvas, pipe: i32): bool {
//       const atlas = canvas.loadTextureFromRes("/ui.iwi");
//       if (atlas <= 0) return false;
//       return canvas.bindTexture(pipe, 0, atlas) == 0;
//     }
//
//     draw(p: Painter): void {
//       widget.text(p, "Hits: " + this.hits.toString(), 8, 8, NORMAL);
//     }

export * from "./theme";
export * from "./painter";
export * from "./flow";
export * from "./hit";
export * from "./widget";
