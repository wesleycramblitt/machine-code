id: d74362
branch: mc/on-the-new-run-page-make-the-minfit-cycle-smarte-d74362
commit: 6b231754268852c81d8c7bb1196123ec10e497fb
acceptance: script:build

Auto-created from run.

On the new run page, make the minFit cycle smarter. Just make it literally a number between 2 ranges that you add 0.25 to until it rotates around. There is no need for "role" terminology, and when a default is set, to say, 6.5 when I fisrt enter the screen, If I then hit "f" to cycle it should add 0.25 to the default not go all the way back to 4.
