commit: 2212f614b648fd3bdd67129571715a1f0ca31f61
acceptance: script:build

On the run details page in the TUI, in the changes section, we need to be able to see the full git diff changes. All changed files with +++ ----, and then if we click into those files it should show full details of edits (just pass through what is returned from git status/ git diff at different levels with different useful paramters)
