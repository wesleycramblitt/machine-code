id: e8e54f
branch: mc/like-in-the-case-of-this-run-20261116-114140-7am-e8e54f
acceptance: script:build

Auto-created from run.

Like in the case of this run: 20261116-114140-7amo, if there are merge issues into main, instead of starting a new run, shouldn't the same run continue with the error message, akin to failing an acceptance gate? The other runs that proceed after waste several calls trying to understand context as it is now since a new run has to be created. This happens on orchestration mode.
