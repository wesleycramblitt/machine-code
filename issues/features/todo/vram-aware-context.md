tags: models
acceptance: script:build
todo:
  - [ ] Locate context sizing and local model metadata
  - [ ] Size local-model context from available VRAM
  - [ ] Check the 24GB / 27B case
  - [ ] Finish

Size local-model context to available VRAM (24GB should not request 262k with a 27b model)
