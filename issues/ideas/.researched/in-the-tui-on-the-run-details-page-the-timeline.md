<<<<<<< HEAD
acceptance: research:verify

In the TUI, on the run details page, the timeline and thinking tabs could be massively improved to be more human readable.We should combine them into one tab, Timeline is fine for that, so just remove thinking.Currently, most of the needed information is shown, but it isn't every easy to read.We should somewhat mimic how other coding agents shows current thinking and tool call diffs in a human readable form, and also add our own.Here are some examples of changes to make for each type of section:1.) input:Show the actual core body of the prompt, the most relevant part to this step, hide all of the other context unless the user clicks into it.2.) thinking/output:Thinking lines should work like the thinking section, scrolling currently streamed outputs from the model.3.) tools:For tools calls, show the call request and response in human readable format. For example:Grep might show:grep: stringglob: *.tsignoreCase: falseoutput:Then we can have a formatted section showing the output of the grepSame with reads, edits, and so on. We can even show lines, some basic color encoding, and diffs.This way it is very easy to track what the model is currently changing.For all tools, make it human readable in this way.4.) timingCurrently it seems like calls are split between several timestamps. I think it makes more sense to group all commands per call together somehow visually.
=======
# Research: Improve the Run Details timeline

The Run Details page has separate Timeline and Thinking sections. Timeline previews prompts, tool requests/results, model output, and edit diffs; Thinking shows streamed assistant text and edit diffs. The concrete gap is that Thinking is not combined with Timeline, and streamed content is not shown there as it arrives. Grouping related model and tool events by call also needs design work because the current timeline renders separate event rows.

The existing feature issue, `issues/features/todo/run_details_timeline_redesign.md`, captures the requested user-facing change.
>>>>>>> mc/in-the-tui-on-the-run-details-page-the-timeline
