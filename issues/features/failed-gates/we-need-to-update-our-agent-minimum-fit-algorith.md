acceptance: script:build
todo:
  - [ ] Locate the change
  - [ ] Make the smallest edit
  - [ ] Finish

Auto-created from run.

We need to update our agent minimum fit algorithm. Currently, we use weights per agent to calculate minFit capabilities per agent. This works great most of the time, we can weight code higher for the engineer agent, and reasoning higher for research, the problem lies in models like ling-3.1-flash where reasoning is very high 8.7, while code is 5.52 and general is 5.3. With an agent like that, we should heavily penalize the lower numbers. I'd like to use this algorithm with p = -2: My preferred algorithm: Weighted generalized meanThe generalized mean lets you control how strongly low scores influence the result.For a normal weighted arithmetic mean, the power is \(p=1\).For a weighted geometric mean, \(p\) approaches zero.For a weighted harmonic mean, \(p=-1\).For stronger emphasis on weak factors, you use increasingly negative values.\[S_p =\left(\frac{\sum_i w_i x_i^p}{\sum_i w_i}\right)^{1/p}\]Where:- \(x_i\) = capability score.- \(w_i\) = importance weight.- \(p\) = imbalance sensitivity.

## Gate failure
Attempt: 1

$ script:build
sibly 'undefined'.
src/cli/runs.ts(633,35): error TS18048: 'row' is possibly 'undefined'.
src/cli/runs.ts(633,77): error TS18048: 'row' is possibly 'undefined'.
src/cli/system.ts(19,10): error TS2305: Module '"../select.js"' has no exported member 'pick'.
src/cli/system.ts(19,16): error TS2305: Module '"../select.js"' has no exported member 'axisWeights'.
src/cli/system.ts(40,10): error TS2305: Module '"../select.js"' has no exported member 'isFreeRow'.
src/loop.ts(17,10): error TS2305: Module '"./select.js"' has no exported member 'estimateTokens'.
src/loop.ts(17,26): error TS2305: Module '"./select.js"' has no exported member 'pick'.
src/loop.ts(17,32): error TS2305: Module '"./select.js"' has no exported member 'providerMultiplier'.
src/loop.ts(17,52): error TS2305: Module '"./select.js"' has no exported member 'isFreeRow'.
src/loop.ts(17,63): error TS2305: Module '"./select.js"' has no exported member 'relaxPinForFailure'.
src/loop.ts(799,46): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(799,69): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(801,38): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(803,23): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(804,16): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(804,32): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(807,22): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(817,12): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(1292,45): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(1292,68): error TS18047: 'currentRow' is possibly 'null'.
src/loop.ts(1303,16): error TS18047: 'currentRow' is possibly 'null'.
src/select.ts(2,39): error TS2304: Cannot find name 'AxisScores'.
src/select.ts(2,60): error TS2304: Cannot find name 'AxisWeights'.
src/select.ts(10,22): error TS2304: Cannot find name 'CAPABILITY_AXES'.
src/tui.ts(74,10): error TS2305: Module '"./select.js"' has no exported member 'axisWeights'.
src/tui.ts(74,23): error TS2305: Module '"./select.js"' has no exported member 'effectiveCallCost'.
src/tui.ts(74,42): error TS2305: Module '"./select.js"' has no exported member 'estimateTokens'.
src/tui.ts(74,58): error TS2305: Module '"./select.js"' has no exported member 'isMetaRouter'.
src/tui.ts(74,72): error TS2305: Module '"./select.js"' has no exported member 'modelStatus'.
src/tui.ts(74,85): error TS2305: Module '"./select.js"' has no exported member 'pick'.
src/tui.ts(503,25): error TS2571: Object is of type 'unknown'.
src/tui.ts(503,32): error TS2571: Object is of type 'unknown'.
src/tui.ts(518,36): error TS7006: Parameter 'candidate' implicitly has an 'any' type.
src/tui/fork.ts(4,10): error TS2305: Module '"../select.js"' has no exported member 'isFreeRow'.
src/tui/screens/models.ts(13,10): error TS2305: Module '"../../select.js"' has no exported member 'axisWeights'.
src/tui/settings.ts(12,10): error TS2305: Module '"../select.js"' has no exported member 'axisWeights'.
