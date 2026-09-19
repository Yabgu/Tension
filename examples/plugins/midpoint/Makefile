# The sample plugin, built the way a host application would build one:
# a shared object whose tension_solver_* references are resolved by the
# host process at load time (they are deliberately left undefined here —
# do not add -Wl,-z,defs).
#
# tension-core itself has no plugin load-from-disk path (DESIGN.md §11);
# the in-tree P7 tests compile this same midpoint.c into the test binary
# from tension-core/build.rs, so the example source is exercised verbatim.
#
# Usage:
#   make        # builds build/midpoint.so
#   make clean  # removes it

CC      ?= cc
CFLAGS  ?= -std=c99 -O2 -fno-fast-math -fPIC -Wall -Wextra
INCLUDE  = -I ../../../tension-solver/include

build/midpoint.so: midpoint.c
	mkdir -p build
	$(CC) $(CFLAGS) $(INCLUDE) -shared -o $@ midpoint.c

clean:
	rm -rf build

.PHONY: clean
