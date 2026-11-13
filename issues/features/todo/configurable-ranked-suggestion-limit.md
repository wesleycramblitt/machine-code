priority: medium
keywords: suggested files, top 10, suggestion limit
acceptance: script:build

# Configure the ranked file suggestion limit

Issue-created runs currently rank only three files by default. Expose the ranked suggestion limit as a setting, with a default of ten. Rank every eligible file before applying the configured cap, then include the highest-ranked files first. Keep direct file citations and exact symbol or literal pins ahead of ranked suggestions. The selected files must retain their current ordering and must not exceed the configured ranked-file limit, except for direct pins that existing behavior treats separately.

Acceptance: the setting defaults to ten, users can change it, and suggestion generation returns the highest-ranked files up to that limit.