id: 02d5dc
branch: mc/the-referenced-feature-was-just-implemented-to-f-02d5dc
acceptance: script:build

Auto-created from run.

The referenced feature was just implemented to fix an issue where a merge into main failed. I remembered, I thought we had a system of first merging main into the branch before merging the branch into main? This will make it much easier to the agent/model to figure out what is wrong if it has main's code locally after the merge. If we don't have that, it should be implemented, and be one of the required gates as well
