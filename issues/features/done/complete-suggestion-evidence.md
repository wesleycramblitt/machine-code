priority: high
keywords: suggested files, keyword matches, symbol information, context holdings
acceptance: script:build

# Include complete evidence for selected suggestion files

Issue-created runs currently omit some match evidence: keyword line evidence can be limited to four displayed locations and is dropped when a keyword has more than twenty hits. Small suggested files skip enrichment, and the context holdings can inline file contents without adding symbol information. This makes selected files harder to locate and understand from the initial prompt.

For each selected suggested file, include every request-keyword match location and its containing symbol information in the initial context, whether the file contents appear inline or as an outline. Preserve all symbol information for that file alongside file contents. Keep the configured ranked-file cap separate: this issue covers complete evidence for selected files, not how many files ranking selects.

Acceptance: for selected files, the initial context gives all matching line numbers without a hit-count cutoff and includes symbol names and ranges even when file contents are inlined; it does not report evidence that enrichment skipped as complete.