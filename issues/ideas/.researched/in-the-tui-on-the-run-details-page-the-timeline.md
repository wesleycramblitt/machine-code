# Research: Improve the Run Details timeline

The Run Details page has separate Timeline and Thinking sections. Timeline previews prompts, tool requests/results, model output, and edit diffs; Thinking shows streamed assistant text and edit diffs. The concrete gap is that Thinking is not combined with Timeline, and streamed content is not shown there as it arrives. Grouping related model and tool events by call also needs design work because the current timeline renders separate event rows.

The existing feature issue, `issues/features/todo/run_details_timeline_redesign.md`, captures the requested user-facing change.