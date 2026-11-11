tags: runs

todo:
  - [x] Read and scope the idea
  - [x] Write features/bugs or curate references
  - [x] Finish

We need to investigate how to have maximum efficiency with our runs from a perspective of exactly what context to keep, what tools to give models,
what prompts to use, and so on. We've already investigated this quite a bit, and converged on a design, but I still notice a lot of runs
wasting dozens of calls rereading files, then making edits, and finishging after ~30 calls, when it could have been 3-5. Even with very strong models.
We need to figure out how to make this process optimal: 
1.) Give the model the exact context it needs or very close to it with really good hints.
2.) Model asks for what it needs in 1 call with multiple smart tool calls.
3.) Model has what it needs, makes all edits.
4.) Finish.

That is ideal, if we go do 2x as much for a medium task that's okay, and maybe 3x for a hard task. 30 calls should be extremely rare for a massive task.
Analyze what we currently have and carefully figure out what needs to be improved or rewritten at each stage of the process:
1.) Base prompts, agents prompts, and any other injected prompting.
2.) All forms of context we provide, and how it accrues across a run.
3.) Available tools and tool descriptions.
4.) Any harness algorithms, caps, gates, blocks, and so on.

Default to asking if you aren't sure what feature to implement, try to use the latest research to make educated gueses. 
Then finally, after planning this thoroughly, create detailed feature issues.
