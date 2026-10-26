# Claude Code Panel

A side panel for Claude Code in VS Code that shows:

- **Usage**: your 5-hour and weekly limits, plus how full the current chat's context is
- **Workspace**: the open folder, git branch and how many files changed
- **A pixel chick** that reacts to what Claude is doing
- **Task Progress**: Claude's to-do list, live

It has two parts. Install both.

## 1. The panel (Claude Code mod)

Type this at the Claude Code prompt:

```
/plugin install usage-pane --marketplace phatblr/claude-code-panel
```

Answer `y` to add the marketplace, then pick a scope (user = every project). Start a new chat; the panel opens by itself. Type `/usage-pane` to reopen it.

## 2. The usage numbers (VS Code extension)

The panel reads the 5-hour and weekly numbers from a small VS Code extension.

1. Download `claude-usage-limit-*.vsix` from [Releases](https://github.com/phatblr/claude-code-panel/releases).
2. In VS Code: Extensions view → `···` menu → **Install from VSIX...** → pick the file.
3. Run **Developer: Reload Window**.

The status bar then shows something like `✨ 5h 42% · 7d 41%`.

## Requirements

- macOS (the extension reads Claude Code's login from the macOS Keychain on your own machine; nothing is sent anywhere except Anthropic)
- Claude Code with mod support, used inside VS Code

## Good to know

- The usage numbers come from an endpoint Anthropic has not documented. It can change or stop working at any time.
- Numbers refresh every 5 minutes and are shared across VS Code windows to avoid rate limits.

## License

MIT
