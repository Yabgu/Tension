// The command palette: named commands a UI can list and invoke by id.
//
// ## Why a factory object and not a handler
//
// The natural shape is `commands.register("move", (args) => { … })`, and it is the
// one shape this toolchain cannot run: a closure over a stack local traps at
// `call_indirect` (`scene.ts` records the four measurements that forced
// `FrameStep`). A factory object also carries two things a bare handler cannot —
// the **title** a palette row draws, and the id it dispatches on — so the same
// object serves the menu, the keybinding table and the test harness.
//
// ## Why `make` does not take the document
//
// A command is constructed *before* the history applies it, and the interesting
// case is one that cannot be fully built yet: "add a node" does not know which id
// the document will hand out until it runs. `AddNode` answers that by allocating on
// its first `apply` when the id is `ALLOCATE_ID`, which keeps `make` a pure
// function of its arguments and keeps the palette free of document state except
// the one it dispatches into.

import {
  AddNode, ALLOCATE_ID, Command, History, RemoveNode, Reparent, SetProperty, SetX, SetY,
} from "./command";
import { Document, NO_PARENT, PropKind, ROOT_ID } from "./document";

/**
 * What a palette caller supplies.
 *
 * One flat record rather than a variant per command: a UI form is a handful of
 * fields, and a typed union here would be re-modelled by every caller anyway. A
 * factory reads what it needs and ignores the rest — `Args.kind` is meaningless to
 * `Reparent` and `Args.parent` is meaningless to `SetX`.
 */
export class Args {
  /** The node a command acts on, or `NO_PARENT` for "whatever is selected". */
  id: i32 = NO_PARENT;
  /** The parent an added or reparented node lands under. */
  parent: i32 = ROOT_ID;
  /** The value for a numeric command. */
  value: f32 = 0.0;
  /** The name for an added node. */
  text: string = "";
  /** Which property a `set-property` acts on. */
  kind: PropKind = PropKind.X;

  static forNode(id: i32): Args {
    const args = new Args();
    args.id = id;
    return args;
  }
}

/** One command the palette can run. */
export interface CommandFactory {
  /** The stable dispatch key — `node.add`, `node.set-x`. Used by menus and keys. */
  id(): string;
  /** The row a palette draws. */
  title(): string;
  /** Build the command this call describes. */
  make(args: Args): Command;
}

/** One row of `Palette.list()`, for a UI that walks the registered commands. */
export class CommandInfo {
  id: string;
  title: string;

  constructor(id: string, title: string) {
    this.id = id;
    this.title = title;
  }
}

// ── the factories ─────────────────────────────────────────────────────────

export class AddNodeFactory implements CommandFactory {
  id(): string { return "node.add"; }
  title(): string { return "Add Node"; }
  /**
   * Always allocates: **`args.id` is ignored.**
   *
   * It has to be. `Args.id` means "the node this command acts on", and `run`
   * resolves it from the selection when it is absent — which for a *create* is
   * nonsense: the field would name the node being made, and the selection would
   * silently become its id. That is what shipped first: `node.add` inserted at
   * the selected node's id, found it alive, refused, and left an undo entry that
   * undid nothing.
   *
   * A user does not choose ids. The document hands them out, and a caller that
   * genuinely needs a specific one constructs `AddNode` directly.
   */
  make(args: Args): Command {
    const name = args.text.length > 0 ? args.text : "node";
    return new AddNode(ALLOCATE_ID, args.parent, name);
  }
}

export class RemoveNodeFactory implements CommandFactory {
  id(): string { return "node.remove"; }
  title(): string { return "Remove Node"; }
  make(args: Args): Command { return new RemoveNode(args.id); }
}

export class SetXFactory implements CommandFactory {
  id(): string { return "node.set-x"; }
  title(): string { return "Set X"; }
  make(args: Args): Command { return new SetX(args.id, args.value); }
}

export class SetYFactory implements CommandFactory {
  id(): string { return "node.set-y"; }
  title(): string { return "Set Y"; }
  make(args: Args): Command { return new SetY(args.id, args.value); }
}

export class SetPropertyFactory implements CommandFactory {
  id(): string { return "node.set-property"; }
  title(): string { return "Set Property"; }
  make(args: Args): Command { return new SetProperty(args.id, args.kind, args.value); }
}

export class ReparentFactory implements CommandFactory {
  id(): string { return "node.reparent"; }
  title(): string { return "Reparent"; }
  make(args: Args): Command { return new Reparent(args.id, args.parent); }
}

/**
 * The registry.
 *
 * Holds the `History` because that is what "run a command" means: an edit that is
 * not in the undo stack is an edit a user cannot take back, so there is no
 * `run` that skips it. A palette that only lists — a menu with no document open —
 * is `list()` without a `History`, and is why `create` takes one but `list` needs
 * nothing.
 */
export class Palette {
  private factories: Array<CommandFactory> = new Array<CommandFactory>();
  private history: History;

  private constructor(history: History) {
    this.history = history;
  }

  static create(history: History): Palette {
    return new Palette(history);
  }

  /** The history every `run` records into. */
  get stack(): History {
    return this.history;
  }

  register(factory: CommandFactory): void {
    // A duplicate id would make dispatch depend on registration order, which is
    // exactly the thing an id is supposed to settle. The later one wins, and the
    // replacement is visible in `list()` rather than silently shadowed.
    for (let i: i32 = 0; i < this.factories.length; i++) {
      if (this.factories[i].id() == factory.id()) {
        this.factories[i] = factory;
        return;
      }
    }
    this.factories.push(factory);
  }

  get count(): i32 {
    return this.factories.length;
  }

  find(id: string): CommandFactory | null {
    for (let i: i32 = 0; i < this.factories.length; i++) {
      if (this.factories[i].id() == id) return this.factories[i];
    }
    return null;
  }

  /** Every registered command, in registration order — the rows a palette draws. */
  list(): Array<CommandInfo> {
    const out = new Array<CommandInfo>();
    for (let i: i32 = 0; i < this.factories.length; i++) {
      out.push(new CommandInfo(this.factories[i].id(), this.factories[i].title()));
    }
    return out;
  }

  /**
   * Build and run the command `id` names through the history.
   *
   * False for an unknown id — and *nothing is applied*, which is the property that
   * makes a typo in a keybinding table a no-op rather than an edit.
   *
   * `args.id == NO_PARENT` means "act on the current selection": the palette is
   * driven by a panel that knows what is selected, and a command that required an
   * explicit id would make every caller repeat the lookup.
   */
  run(doc: Document, id: string, args: Args): bool {
    const factory = this.find(id);
    if (factory == null) return false;
    const resolved = args;
    if (resolved.id == NO_PARENT) {
      const selected = doc.firstSelected();
      if (selected != NO_PARENT) resolved.id = selected;
    }
    this.history.exec(doc, factory.make(resolved));
    return true;
  }
}

/** Register the commands this build ships. One call, so a shell has one line. */
export function registerEditorCommands(palette: Palette): Palette {
  palette.register(new AddNodeFactory());
  palette.register(new RemoveNodeFactory());
  palette.register(new SetXFactory());
  palette.register(new SetYFactory());
  palette.register(new SetPropertyFactory());
  palette.register(new ReparentFactory());
  return palette;
}

/** `ALLOCATE_ID`, re-exported so a caller does not import `command` for one name. */
export { ALLOCATE_ID };
