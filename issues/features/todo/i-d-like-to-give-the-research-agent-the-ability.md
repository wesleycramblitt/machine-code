id: c107ed
branch: mc/i-d-like-to-give-the-research-agent-the-ability-c107ed
acceptance: script:build

Auto-created from run.

I'd like to give the research agent the ability to create references. We already have the reference skill, but nothing in the research prompt specifies being able to create a reference as an output. Also, we would need the creation of references as an output gate.  By default, I think we should create them at references/ in the repo. So research:verify could look for an output there.  We need to be very careful changing the research prompt, it works wonderfully now. Basically we just need a line saying that the agent can create references specifically when asked to. Confirm the prompt change with me in the ask tool before commiting to it.
