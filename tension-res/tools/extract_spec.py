#!/usr/bin/env python3
"""Extract FID constants and field data-length facts from the pinned ECMA-208 text.

Input : tension-res/spec/ECMA-208_1st_edition_december_1994.txt  (pdftotext -layout)
Outputs (all idempotent; markers must exist in the target files):
  --zig  src/fields.zig    : the `Fid` constants block
  --facts-zig test/fields_test.zig : the Annex C facts table used by the
                                     cross-check test

Why this exists: the project rule is "no parser written from memory".  Every FID
value and field width in the engine is derived from the standard's own text,
not from recall.  Re-run after re-extracting the PDF:

    pdftotext -layout ECMA-208_1st_edition_december_1994.pdf ECMA-208_1st_edition_december_1994.txt
    python3 tools/extract_spec.py --zig src/fields.zig --facts-zig test/fields_test.zig

Sources, as printed in the pinned document:
  Annex D (~lines 3862-4165) : "#<hex>  <NAME>"   (informative registry)
  Annex C (~lines 2533-3861) : "<NAME> / FID: #<hex> / Data length: <...>"  (normative)

Four fields are used by the format but missing from Annex D (or listed there as
"see annex E"); they are supplied explicitly below, each with its own citation,
so nothing enters the codebase unsourced.
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "spec" / "ECMA-208_1st_edition_december_1994.txt"

# Fields used by the format whose values are not in Annex D's list, with the
# text that does specify them.  (fid_hex, name, zig_override | None, source)
SUPPLEMENTS = [
    ("00", "NULL FIELD", "NULL_FIELD", "10.4.1 (NULL Field is the single byte #00)"),
    ("8052", "FORMAT NAME", None, "Annex C (FORMAT NAME); Annex D lists #8052 as 'see annex E'"),
    ("808043", "REGISTERED IDENTIFIER", None, "Annex C (REGISTERED IDENTIFIER); absent from Annex D"),
    ("81F2FB", "DATA STREAM SIZE", None, "Figure 27 (13.14); absent from Annex D"),
]

ANNEX_D_RE = re.compile(r"^#([0-9A-F]{2,8})\s{2,}(\S.*)$")
FID_LINE_RE = re.compile(r"^\s*FID:\s+(#[0-9A-F]{2,8})\s*$")
LEN_LINE_RE = re.compile(r"^\s*Data length:\s+(.+?)\s*$")
FIXED_RE = re.compile(r"^Fixed,\s*(\d+)\s*byte")


def find_annex(lines: list[str], letter: str, text: str | None = None) -> int:
    if text is None:
        text = "\n".join(lines)
    for i, line in enumerate(text.splitlines()):
        if line.strip() == f"Annex {letter}":
            return i
    raise SystemExit(f"Annex {letter} title not found in {SPEC}")


def parse_annex_d(lines: list[str]) -> list[tuple[str, str, str]]:
    """[(fid_hex, name, source)] for every FID Annex D specifies by name."""
    text = "\n".join(lines)
    start, end = find_annex(lines, "D", text), find_annex(lines, "E", text)
    out = []
    for line in lines[start:end]:
        m = ANNEX_D_RE.match(line.rstrip())
        if not m:
            continue
        fid, name = m.group(1), m.group(2).strip()
        if name.lower().startswith("see annex e"):
            continue
        out.append((fid, name, "Annex D"))
    for fid, name, _override, source in SUPPLEMENTS:
        out.append((fid, name, source))
    return out


def parse_annex_c(lines: list[str]) -> list[tuple[str, str, str]]:
    """[(name, fid_hex, data_length_spec)] from the normative Field specification."""
    text = "\n".join(lines)
    start, end = find_annex(lines, "C", text), find_annex(lines, "D", text)
    body = lines[start:end]
    out = []
    i = 0
    while i < len(body):
        stem = body[i].rstrip().strip()
        if stem and re.fullmatch(r"[A-Z][A-Z0-9 ()/'\-\.]+", stem) and len(stem) > 2:
            fid = length = None
            for j in range(i + 1, min(i + 8, len(body))):
                if fid is None and FID_LINE_RE.match(body[j]):
                    fid = FID_LINE_RE.match(body[j]).group(1).lstrip("#")
                elif length is None and LEN_LINE_RE.match(body[j]):
                    length = LEN_LINE_RE.match(body[j]).group(1)
                if fid and length:
                    break
            if fid and length:
                out.append((stem, fid, length))
                i += 1
                continue
        i += 1
    return out


def zig_name(name: str, override: str | None = None) -> str:
    if override:
        return override
    s = re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")
    return s


def fid_len(fid_hex: str) -> int:
    """Annex A encodes FIDs big-endian with no leading zero byte, so the
    minimal byte count of the value is the byte length of the FID."""
    return max(1, (len(fid_hex) + 1) // 2)


def emit_fid_block(fids: list[tuple[str, str, str]], widths: dict[str, str]) -> str:
    lines = [
        "// --- BEGIN GENERATED: FID constants (tools/extract_spec.py) ---",
        "//",
        "// Transcribed from the pinned standard. Each entry's comment names the",
        "// annex it came from. The numeric value is the FID's byte sequence read",
        "// as a big-endian integer (#808000 = bytes 80 80 00; #01 = byte 01),",
        "// which is exactly the notation Annex A uses for FID structure.",
        "",
    ]
    seen: dict[str, str] = {}
    for fid, name, source in fids:
        zig = zig_name(name)
        if zig in seen:
            zig = f"{zig}_{fid}"
        seen[zig] = fid
        width = widths.get(name.upper())
        note = f"  // {source}"
        if width:
            note += f"; Annex C data length: {width}"
        override = next((o for f, n, o, _s in SUPPLEMENTS if f == fid and n == name), None)
        if override:
            zig = override
        lines.append(
            f"pub const {zig} = Fid{{ .code = 0x{fid}, .len = {fid_len(fid)} }};{note}"
        )
    lines += ["", "// --- END GENERATED ---"]
    return "\n".join(lines)


def emit_facts_block(facts: list[tuple[str, str, str]]) -> str:
    fixed, other = [], []
    for name, fid, length in facts:
        m = FIXED_RE.match(length)
        if m:
            fixed.append((name, fid, int(m.group(1))))
        else:
            other.append((name, fid, length))
    out = [
        "// --- BEGIN GENERATED: Annex C field facts (tools/extract_spec.py) ---",
        "//",
        "// Every field the normative Annex C declares with a fixed data length,",
        "// and every field it declares Variable or Bit Data. `fields.fixedLen`",
        "// must reproduce the fixed widths and return null for the others;",
        "// `known_fid_variable_annex_c_fixed` lists the FIDs whose bit structure",
        "// (Annex A) implies a variable data part while Annex C declares a fixed",
        "// length — recorded as an explicit, cited exception, never silently.",
        "",
        "pub const spec_fixed = [_]SpecFixed{",
    ]
    for name, fid, n in sorted(fixed):
        out.append(
            f'    .{{ .name = "{name}", .fid = .{{ .code = 0x{fid}, .len = {fid_len(fid)} }}, .bytes = {n} }},'
        )
    out += ["};", "", "pub const spec_non_fixed = [_]SpecNonFixed{"]
    for name, fid, kind in sorted(other):
        out.append(
            f'    .{{ .name = "{name}", .fid = .{{ .code = 0x{fid}, .len = {fid_len(fid)} }}, .kind = "{kind}" }},'
        )
    out += ["};", "// --- END GENERATED ---"]
    return "\n".join(out)


def rewrite(path: Path, block: str) -> None:
    src = path.read_text(encoding="utf-8")
    begin = block.splitlines()[0]
    end = "// --- END GENERATED ---"
    if begin not in src or end not in src:
        raise SystemExit(f"{path}: generated markers not found")
    pre = src[: src.index(begin)]
    post = src[src.index(end) + len(end):]
    path.write_text(pre + block + post, encoding="utf-8")
    print(f"# wrote {len(block.splitlines())} lines into {path}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zig", type=Path, help="rewrite the FID constants block here")
    ap.add_argument("--facts-zig", type=Path, help="rewrite the Annex C facts block here")
    args = ap.parse_args()

    lines = SPEC.read_text(encoding="utf-8", errors="replace").splitlines()
    fids = parse_annex_d(lines)
    fields = parse_annex_c(lines)
    widths = {name.upper(): length for name, _fid, length in fields}

    print(f"# Annex D: {len(fids) - len(SUPPLEMENTS)} + {len(SUPPLEMENTS)} supplied FIDs", file=sys.stderr)
    print(f"# Annex C: {len(fields)} field entries", file=sys.stderr)

    if args.zig:
        rewrite(ROOT / args.zig if not args.zig.is_absolute() else args.zig, emit_fid_block(fids, widths))
    if args.facts_zig:
        rewrite(ROOT / args.facts_zig if not args.facts_zig.is_absolute() else args.facts_zig, emit_facts_block(fields))

    for name, fid, length in fields:
        print(f"{fid}\t{name}\t{length}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
