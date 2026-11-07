Here are the 10 most useful research URLs, ranked by relevance to building `machine-code`. These are current through November 7, 2026.

## Top 10

| #  | Research                                                                                                                                                                                      | Date     | Primary relevance                                 |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| 1  | [An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804?utm_source=chatgpt.com)                                                                             | Sep 2026 | Planning, tools, context management               |
| 2  | [Beyond the Model: Demystifying Harness Effects](https://arxiv.org/abs/2609.32459?utm_source=chatgpt.com)                                                                                     | Sep 2026 | Model-dependent harness design, subagents         |
| 3  | [Pairing Matters: Performance, Failures, and Efficiency in Lightweight Coding Agents](https://arxiv.science/abs/2610.32131?utm_source=chatgpt.com)                                            | Oct 2026 | Open-weight models, harness/model compatibility   |
| 4  | [Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents](https://arxiv.org/abs/2609.00006?utm_source=chatgpt.com)                                                         | Jul 2026 | Architecture of 11 production harnesses           |
| 5  | [Runtime-Structured Task Decomposition for Agentic Coding Systems](https://arxiv.org/abs/2605.15425?utm_source=chatgpt.com)                                                                   | May 2026 | Deterministic orchestration, retries, task graphs |
| 6  | [Code as Agent Harness](https://arxiv.org/abs/2605.18747?utm_source=chatgpt.com)                                                                                                              | May 2026 | Planning, memory, tools, multi-agent architecture |
| 7  | [Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://www.sri.inf.ethz.ch/publications/gloaguen2026agentsmd?utm_source=chatgpt.com)                   | 2026     | Context files, instruction overhead               |
| 8  | [Anthropic: Harness Design for Long-Running Application Development](https://www.anthropic.com/research/harness-design-long-running-apps?utm_source=chatgpt.com)                              | Mar 2026 | Context resets, planning, evaluator agents        |
| 9  | [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents?trk=public_post_comment-text\&utm_source=chatgpt.com) | Nov 2025 | Persistent state, handoffs, incremental execution |
| 10 | [OpenAI: Harness Engineering — Leveraging Codex in an Agent-First World](https://openai.com/index/harness-engineering/?utm_source=chatgpt.com)                                                | Feb 2026 | Repository knowledge, automation, feedback loops  |

## Three additional URLs worth keeping

These are particularly useful reference collections and implementation resources:

- [Awesome Agent Engineering](https://github.com/ggjy/Awesome-Agent-Engineering?utm_source=chatgpt.com) — research collection associated with the agent/harness survey.
- [Mini-SWE-Agent](https://github.com/SWE-agent/mini-swe-agent?utm_source=chatgpt.com) — minimal coding-agent implementation.
- [OpenHands](https://github.com/All-Hands-AI/OpenHands?utm_source=chatgpt.com) — production-oriented open agent platform.

## My recommended reading order

If you're going to read only five, I'd choose:

1. \#1 — Understand which harness components actually improve performance.
2. \#3 — Understand why the same model behaves differently under different harnesses. Particularly relevant to your local Qwen and DeepSeek models.
3. \#2 — Understand structured tools, lazy skills, and specialized subagents.
4. \#5 — Understand how to build deterministic orchestration around LLM decisions.
5. \#4 — Examine how real coding-agent implementations organize their architecture.

One especially important finding from #3: the same model had resolution rates differing by as much as 44 percentage points depending on the harness. That's a strong reason to benchmark your model/harness combinations rather than assuming the best model on a leaderboard will be the best model in your system.&#x20;


My strongest recommendation: Start with papers #1, #2, #3, and #5. Together, they address almost exactly the engineering decisions you're trying to make: context budgets, weaker versus stronger models, tool interfaces, task decomposition, and deterministic orchestration.
