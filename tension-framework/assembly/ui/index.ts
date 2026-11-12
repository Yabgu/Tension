// `tension-ui`: the toolkit a Tension guest draws a UI with.
//
// ## The pieces
//
//   * `theme.ts`   what an atlas is — cell size, colour stripes, chrome cells.
//   * `fonts.ts`   a baked (font, size) page, and the book that indexes them.
//   * `painter.ts` sprite records: rectangles, rules, glyphs, with a clip.
//   * `layout.ts`  the retained tree: a widget pool, measure, arrange, paint.
//   * `builder.ts` how a guest authors that tree, once, at startup.
//   * `events.ts`  focus, capture, the bubble — what input does to the tree.
//   * `behavior.ts` how a widget measures, arranges, paints and handles — the open half.
//   * `text.ts`    owned text buffers, the appender, and the frame's pool.
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
//       return loadFontBook(canvas, pipe) == 0;
//     }
//
//     draw(p: Painter): void {
//       this.ui.tree.paint(p, this.ui.hits);
//     }
//
// `apps/docs` and `apps/editor` are the two worked examples; both also show the
// extension point (`ui.node(parent, new MyBehavior())`) that a page flow or a
// viewport rectangle needs.

export * from "./theme";
export * from "./painter";
export * from "./hit";
export * from "./fonts";
export * from "./text";
export * from "./layout";
export * from "./event-def";
export * from "./events";
export * from "./behavior";
export * from "./builder";
