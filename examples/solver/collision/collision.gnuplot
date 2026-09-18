# collision.gnuplot — render positions.dat (t x0 y0 r0 x1 y1 r1) as an
# animated GIF: two circles moving in a square wall, one frame per sample.
#
#   gnuplot collision.gnuplot          (run.sh runs this for you)
#
# gnuplot's data reader skips the file's '#' comment lines, so the frame count
# has to come from the numeric rows. Normally gnuplot counts them itself with
# `stats` — that needs gnuplot >= 4.6 (2012). On anything older, pass the
# count in from the shell, which is what run.sh retries with if the normal
# render fails:
#
#   gnuplot -e "N=$(grep -c '^[^#]' positions.dat)" collision.gnuplot
#
# `N` then arrives from outside and the `stats` call below is skipped. Both
# paths meet in `records`; nothing further down branches on where it came from.

# Count first, and before any range is set: `stats` honours the current x/y
# ranges, so a range in force here would silently drop every sample outside
# it (with xrange [-6:6] on this 0..8 s file, the animation would lose its
# last 2 s — 20 of 81 frames).
if (!exists("N")) { stats "positions.dat" nooutput; N = STATS_records }
records = N

set terminal gif animate delay 10 size 600,600
set output "collision.gif"

set title "Two spheres in a square: soft-spring collision (rk45)"
set xrange [-6:6]
set yrange [-6:6]
set size ratio -1
set border 0
unset xtics
unset ytics
unset key

# The wall: a square centred on the origin, half-width 5.
set object 1 rect from -5,-5 to 5,5 fs empty border lw 2 lc "gray"

# `every ::i::i` addresses data record i with 0-based numbering, so the loop
# runs 0..records-1: every sampled row becomes exactly one frame. delay 10 is
# 0.1 s of playback per frame, matching the 0.1 s sampling of the sim.
do for [i=0:records-1] {
  plot "positions.dat" every ::i::i using 2:3:4 \
         with circles fs transparent solid 0.3 noborder lc "blue", \
       "positions.dat" every ::i::i using 5:6:7 \
         with circles fs transparent solid 0.3 noborder lc "red"
}
