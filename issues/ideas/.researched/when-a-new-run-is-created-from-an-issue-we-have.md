acceptance: research:verify

Auto-created from run.

When a new run is created from an issue, we have a system for extracting keywords and seeding file suggestions. My understanding of this feature is that some files can be inlined into context holdings if they are < 50 lines, otherwise the outline including docs and symbols are included. I want to ensure this system is returning enough information early on to be highly useful. Namely:  All keyword matches and where the matches occur in the files should be in holdings. for example, if "Timeline" pops up 5 times, holdings should have all of those files, line numbers, and symbol information. Each file in holdings, even if showing file data, should always include symbol information.  Figure out why our current system does, what could be improved, and ask me on any uncertainties you have before creating features and bugs to implement a better suggestion system.
