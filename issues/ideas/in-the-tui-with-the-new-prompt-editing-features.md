id: 5d3685
branch: mc/in-the-tui-with-the-new-prompt-editing-features-5d3685
acceptance: research:verify

Auto-created from run.

In the TUI, with the new prompt editing features, there are several problems:
1.) You can't see the cursor other than on the end of the prompt. It should always show where we are on the prompt.
2.) A lot of key commands are overridden by others. For example, on the new issue page, if I hit Alt+d, instead of deleting the next word, it jumps up to editing the "depends" section. Make sure the key commands can work with whatever if configured on the page. We can leave them the save for simplicity, but make Alt+d separate from just d, as an example. 

Build detailed bugs to take care of these issues for all key commands
