# Two spheres in a square — the solver's collision demo

Two soft spheres fall under gravity inside a square wall, collide, bounce off
the walls, and settle on the floor. The physics is integrated by **rk45** with
`source: "wasm"`: the guest writes f(t, y) in AssemblyScript, the host's
solver drives it, and `run.sh` turns the recorded trajectory into an animated
GIF.

This is the ABI a game already has: no new header, no new format. The guest
supplies a derivative and six constants; the solver supplies everything else.

## Run it

```sh
cd examples/solver/collision
./run.sh            # builds the guest, runs it, renders collision.gif
npm start           # the same thing
```

Two outputs appear next to this file (both gitignored):

- `positions.dat` — one CSV row every 0.1 s of sim time, 81 rows:
  `t x0 y0 r0 x1 y1 r1`
- `collision.gif` — the animation gnuplot renders from it, one frame per row.

The one dependency the example does not carry itself is
[gnuplot](http://gnuplot.info) (`sudo apt install gnuplot` on Debian/Ubuntu,
`brew install gnuplot` on macOS). `run.sh` checks for it before doing
anything else and says so if it is missing; set `GNUPLOT=/path/to/gnuplot` to
pick a specific binary. Everything else `run.sh` needs, it installs itself.

## What to look at

- **The overlap during contact.** The two circles visibly intersect in the
  middle, and a circle flattens into the wall for a few frames. That is the
  model working, not a bug: contact is a *spring* whose force grows with
  penetration, so overlap is the contact state itself.
- **The bounce off the walls**, and how each bounce is lower than the last.
- **The clock.** One frame is one 0.1 s sample (`delay 10`), so the animation
  plays at the sim's own speed: 81 frames ≈ 8 s of real time.
- **The settle.** By the end both spheres rest on the floor (their centres sit
  at about y = −4.55: the wall spring supports them with `K_WALL · pen = m·g`,
  a penetration of just under 5 cm) and glide sideways until the side walls
  damp that motion away too.

## The physics model, in one paragraph

Contact is a soft spring: circles push each other apart with stiffness
`K_CC = 800`, the four walls push back with `K_WALL = 200`, and each contact
also damps the velocity along its normal (`DAMPING = 2.0`). Gravity is the
acceleration −9.81. Nothing detects events and nothing applies impulses — the
right-hand side stays a continuous function of the state (C¹ in force; the
acceleration has a kink at the contact boundary, which rk45 steps through by
shrinking its step). That continuity is the point: an impulse or
position-based solver has to *stop* the integration at the moment of contact
and restart it with a different law, which needs the constraint channel this
ABI does not have yet (see `tension-solver/DESIGN.md` §10, spook). The cost of
the soft model is that contacts are visibly squishy, and that stiffness is
bounded by the step size: `K_CC = 800` with mass 1 gives a contact that lasts
a few frames at a 0.1 s sample rate — raise `K` for harder contacts (the
solver will take smaller internal steps) or raise `DAMPING` to stop the
bouncing sooner.

The trajectory in this demo is deliberately bouncy at first and quiet at the
end: `DAMPING = 2.0` is what makes a drop-and-bounce settle inside the 8 s the
example runs. At a token damping the soft springs return almost all of a
contact's energy and the spheres bounce for as long as you care to watch.
`K_CC = 800` with mass 1 is what makes one collision worth a few frames of
visible overlap; raise `K_CC` for a harder, shorter contact or `DAMPING` to
stop the bouncing sooner.

## The files

```
game.ts            the guest: constants, props, _derivative, the run loop
collision.gnuplot  the animation script (slow to a taste with `delay`)
run.sh             build -> run -> render, and prints the two output paths
positions.dat      the CSV (generated)
collision.gif      the animation (generated)
```

## See also

- `tension-solver/GUEST_ABI.md` — the guest-side contract: the five imports,
  the config, the callbacks, the error convention.
- `examples/solver/wasm/game.ts` — the smallest `source: "wasm"` guest (rk45 on
  y' = −y); this example is that one with real physics attached.
- `tension-solver/DESIGN.md` — why the solver is built the way it is
  (§5 determinism, §10 the constraint channel, §12 the config wire).
