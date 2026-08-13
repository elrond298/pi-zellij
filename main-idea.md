run a command via zellij in a new pane
pi can send keys, read, open, close panes.
perhaps useful if want a long running command to show in real time, or control command interactively.

"What is on the screen right now?"	dump-screen
"Tell me when X appears"	subscribe + filtering
"Give me all output as it happens"	subscribe
"Capture the final result after completion"	dump-screen --full (after blocking pane unblocks)
Periodic polling (e.g., every 5 seconds)	dump-screen in a loop

check: https://zellij.dev/documentation/programmatic-control.html
