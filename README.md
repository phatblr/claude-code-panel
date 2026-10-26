# Claude Code Panel

A side panel for Claude Code in VS Code that shows:

- **Usage**: your 5-hour and weekly limits, plus how full the current chat's context is
- **Workspace**: the open folder, git branch and how many files changed
- **A pixel chick** that reacts to what Claude is doing
- **Task Progress**: Claude's to-do list, live

## Install

Type this at the Claude Code prompt:

```
/plugin install usage-pane --marketplace phatblr/claude-code-panel
```

Answer `y` to add the marketplace, then pick a scope (user = every project). Start a new chat; the panel opens by itself. Type `/usage-pane` to reopen it.

## Optional: numbers in the VS Code status bar

The panel fetches its own numbers. If you also want them in VS Code's bottom bar (like `✨ 5h 42% · 7d 41%`), install the small extension too:

1. Download `claude-usage-limit-*.vsix` from [Releases](https://github.com/phatblr/claude-code-panel/releases).
2. In VS Code: Extensions view → `···` menu → **Install from VSIX...** → pick the file.
3. Run **Developer: Reload Window**.

The panel and the extension share one cache file, so running both does not double the requests. The extension needs macOS.

## Requirements

- Claude Code with mod support, used inside VS Code
- Signed in with a Claude account (Pro/Max), not an API key

## Good to know

- The usage numbers come from an endpoint Anthropic has not documented. It can change or stop working at any time.
- The panel uses Claude Code's own sign-in through the mod API; it never sees your token.
- Numbers refresh at most every 5 minutes, shared across chats and windows.

## License

MIT
