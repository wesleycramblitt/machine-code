acceptance: script:build
todo:
  - [x] Locate the change
  - [x] Make the smallest edit
  - [x] Finish

Auto-created from run.

We need to update our agent minimum fit algorithm. Currently, we use weights per agent to calculate minFit capabilities per agent. This works great most of the time, we can weight code higher for the engineer agent, and reasoning higher for research, the problem lies in models like ling-3.1-flash where reasoning is very high 8.7, while code is 5.52 and general is 5.3. With an agent like that, we should heavily penalize the lower numbers. I'd like to use this algorithm with p = -2: My preferred algorithm: Weighted generalized meanThe generalized mean lets you control how strongly low scores influence the result.For a normal weighted arithmetic mean, the power is \(p=1\).For a weighted geometric mean, \(p\) approaches zero.For a weighted harmonic mean, \(p=-1\).For stronger emphasis on weak factors, you use increasingly negative values.\[S_p =\left(\frac{\sum_i w_i x_i^p}{\sum_i w_i}\right)^{1/p}\]Where:- \(x_i\) = capability score.- \(w_i\) = importance weight.- \(p\) = imbalance sensitivity.
