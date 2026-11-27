# spawn — floating tasks

Three tasks, none awaited, all three bodies run.

    npm start

```
spawning three tasks and not awaiting any of them
the entry returns here; the host runs what was spawned
  step 1
work 1 finished (1)
  step 2
work 2 finished (1)
  step 3
work 3 finished (1)
```

`work(1);` in statement position is the program saying *start this and do not wait*. The
task it returns is dropped, so there is nothing to await — and the backend owns the queue,
so every body still runs before the program exits.

The order of the two opening lines is the interesting part: **the entry returns first**.
`await work(1)` would run the body before the next line and hand you its value; that is a
different program, and examples/async-on-main is the one that shows it.

On the fiber backend the guest cannot run a spawned body itself (its stack is a host object),
so it hands the slot to the host's ready queue and the host resumes it after the entry
returns. On continuations the guest's own executor ring is the queue — and there nothing
drives that ring once the entry has returned, so a floating spawn on that backend is
**refused at compile time by name** rather than compiled to a silent zero. Await it, or build
fiber.
