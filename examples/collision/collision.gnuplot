# collision.gnuplot — render positions.dat (t x0 y0 r0 x1 y1 r1) as an
# animated GIF: two circles moving in a square wall, one frame per sample.
#
#   gnuplot collision.gnuplot
#
# run.sh runs this for you. The file's comment lines ('#') are ignored by
# gnuplot's data reader; STATS_records counts the numeric rows, so the
# animation length follows the data rather than a number typed here.

# Count the samples first, before any range is set. `stats` honours the
# current x/y ranges: with xrange [-6:6] in force it would quietly stop at
# t = 6 s of an 0..8 s file and the animation would lose its last 20 frames.
stats "positions.dat" nooutput
records = STATS_records

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
# runs 0..records-1: every sampled row becomes exactly one frame.
do for [i=0:records-1] {
  plot "positions.dat" every ::i::i using 2:3:4 \
         with circles fs transparent solid 0.3 noborder lc "blue", \
       "positions.dat" every ::i::i using 5:6:7 \
         with circles fs transparent solid 0.3 noborder lc "red"
}
