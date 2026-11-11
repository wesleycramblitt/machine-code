priority: high 
review: none
verification: direct
tags: new-run
keywords: New run, Run starting... (awaiting record), TUI
acceptance: script:build

On one of the new repositories I'm testing machine_code in, when I try to start a new run from an Idea, it hangs on "Run starting... (awaiting record)"
for a very long time. The repository in particular, doesn't have any scripts, only a scripts folder, and I know the repository map hasn't been built yet.
    Regarding that, there is a massive repository in it with a ton of massive fortran files. If the issue is just the map taking a long time to build, we 
    need some kind of indicator or progress bar for that, if it is hard failing, an error message would be helpful.
