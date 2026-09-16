# ECMA-208 (SIDF) — pinned spec copy

The implementation in `tension-res/` is written against the published ECMA-208
document. Nothing from the specification is redistributed with this project:
fetch it yourself into this directory if you need to read it, and check it
against the checksums below. The document is Ecma's, not ours.

- **Standard**: ECMA-208, *System-Independent Data Format (SIDF)*
- **Edition**: 1st edition, December 1994. This is the edition the project
  pins; it is the only edition ECMA publishes.
- **Source**: <https://ecma-international.org/publications-and-standards/standards/ecma-208/>
- **PDF**: <https://ecma-international.org/wp-content/uploads/ECMA-208_1st_edition_december_1994.pdf>
- **sha256 (PDF)**: `3d0dee8c948a901ada6233a344761ebdb2389d4606d4aed9edfc4b394727004c`
- **sha256 (pdftotext extraction)**: `caa05e8d1f737402831e1e5c3830aa6c3a9a7bb24744fc35dd8671bdeec467bb`

Local files, once you fetch them (the checksums are how you confirm you have the
same edition this design was written against):

    ECMA-208_1st_edition_december_1994.pdf   289190 bytes, 6 "pages" per `file`,
                                             but the text extraction is ~235 KB
                                             / 4299 lines (the PDF's page tree
                                             is unusual; content is complete)
    ECMA-208_1st_edition_december_1994.txt   pdftotext -layout extraction

Regenerate the text extraction with:

    pdftotext -layout ECMA-208_1st_edition_december_1994.pdf ECMA-208_1st_edition_december_1994.txt

Section numbers cited throughout the code and `../DESIGN.md` refer to this
document: clauses 1–14 and Annexes A–E.
