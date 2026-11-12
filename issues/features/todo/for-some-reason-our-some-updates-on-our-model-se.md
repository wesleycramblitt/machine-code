acceptance: script:build
todo:
  - [ ] Locate the change
  - [ ] Make the smallest edit
  - [ ] Finish

Auto-created from run.

For some reason, our some updates on our model selection algorithm and minFit capabilities, model selection is acting very odd. In the new run page, if I change fit[f] to as high as it will go, the selected model stays as openrouter/baidu/ernie-5.5-flash-preview:free with a fit of 6.17 (should compeltely fail). We recented switched to a smarter math algorithm, but I'm suspecting that it is broken. Deepseek v4 flash should be one of the best selections are ~ 7 min fit. I'm guessing that the algorithm isn't functioning correctly, and the listed fit is wrong as well.
