### Project

We're building a website for multiple players to play the 'hat game' but instead of pieces of paper they can use their devices.
The rules of the game can be found here https://www.thehatgame.net/how-to-play-the-hat-game/
The website is replacing the bits of paper.  Each person should be able to use their own device, and signal team they are in and their name.
At any given time the three roles are: 
- person giving clues to their team
- person guessing clues from the clue-give in their team
- person in the other team, spectating the other team's effort

### Code Navigation

Always use LSP for symbol-based navigation — fall back to grep or Bash only if LSP returns no results or the task isn't symbol-based (e.g. searching string literals).

LSP must be loaded before use: `ToolSearch "select:LSP"`

Prefer these operations:
- `goToDefinition` / `findReferences` — find where a symbol is defined or used (semantic, not text-matching)
- `workspaceSymbol` — locate a class or function by name across the project
- `hover` — get type information without reading the file
- `documentSymbol` — list all symbols in a file
