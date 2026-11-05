# Overview
We need to thoroughly test and improve web fetch, search, and browse capabilities:
## Web fetch
Should be a tool for pulling information from specific urls, we should have the capability to show html, extract text, or even download files.

## Web search
Typically, web search tools rely on services for this, we should plan to wire in 2-3 services free and paid that can be turned on/off for web search, especially embeddings based like Tavily.

## Web browse
Using chromium dev tools or similar mcps, we can do automated web browsing, it should be configurable headless vs not, which mcps or services are active, and so on, and the browse mode should be able to be used to replace web search, since you can browse to a search engine. We browse is also very important for building new references.
