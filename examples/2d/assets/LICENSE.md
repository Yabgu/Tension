# tileset.png — CC0 1.0 Universal

The artwork in this directory (`tileset.png`) was drawn by
`build-tileset.mjs`, which is part of this repository and licensed under the
project's own MIT licence.

To the extent possible under law, the authors have waived all copyright and
related or neighbouring rights to `tileset.png` under the **CC0 1.0 Universal**
public domain dedication:

<https://creativecommons.org/publicdomain/zero/1.0/>

You may copy, modify, distribute and use it, including for commercial purposes,
without asking permission and without attribution.

## Why CC0 and not MIT

The rest of the repository is MIT, and MIT would have been fine — it is only a
question of what a game author has to do to use these tiles in their own
project. MIT asks them to reproduce a copyright notice in their distribution;
CC0 asks nothing. Art that ships inside someone's game should not add a
paperwork step, and this art exists so that nobody has to think about the
licence at all.

## What is *not* covered

`build-tileset.mjs`, `png.mjs` and the JavaScript around them are source code
and remain under the repository's MIT licence (see `../../LICENSE`). CC0 here
applies to the image.

## Provenance

Every pixel is generated from `PALETTE` and the drawing functions in
`build-tileset.mjs`. No third-party asset was traced, sampled, recoloured or
otherwise derived from. There is nothing to attribute because there is nothing
to credit.

This replaced a third-party tileset (LimeZu's *Modern exteriors*), which could
not be committed and therefore could not be used by CI or by anyone without
access to the machine it was stored on.
