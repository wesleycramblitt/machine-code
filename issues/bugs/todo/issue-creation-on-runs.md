priority: medium
review: none
verification: direct
tags: new-runs
acceptance: script:build

When creating a new run, in the TUI, from a manual prompt, instead of from an existing issue, we should create the issue on main
and commit and push the new issue before starting the run. We are currently running into a problem where after the run finishes, we can't
merge the branch back in because the new issue is in both places, uncommited on main.
