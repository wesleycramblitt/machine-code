acceptance: script:build
todo:
  - [x] Locate the change
  - [x] Make j/k scroll the expanded event section instead of ^D/^U
  - [x] Finish

# Ctrl-D/U removal 
Regarding the TUI, on the run details page. When scrolling events, we have the Ctrl D/U commands for scrolling up and down expanded sections. 
Instead, lets use the existing j/k that scrolls up and down the events, and when you hit enter to go into an event section, just have j/k scroll that section instead of Ctrl D/U
