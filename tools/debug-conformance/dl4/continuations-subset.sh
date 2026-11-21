#!/bin/bash
# Re-measure a subset of the conformance matrix against the DEBUG engine binary,
# which reports "async backend: continuations". Same harness, same artifacts,
# same cases; only $TENSION_CORE differs.
cd /home/acakar/work/Tension || exit 1
export TENSION_CORE=/home/acakar/work/Tension/tension-core/target/debug/tension-core
for name in async_statement_before_await async_statement_after_await async_resume_in_loop stack_switch_nested_resume task_entry_first_statement; do
  node tools/debug-conformance/runner.js --no-build --only "$name" > "/tmp/dl4/cont-$name.log" 2>&1
  echo "== $name exit=$?" >> /tmp/dl4/cont-summary.txt
  grep -E "^  (PASS|FAIL)" "/tmp/dl4/cont-$name.log" | head -3 >> /tmp/dl4/cont-summary.txt
done
echo "ALL DONE" >> /tmp/dl4/cont-summary.txt
