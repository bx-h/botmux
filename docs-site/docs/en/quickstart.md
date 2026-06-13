# 5-minute quick setup

> 💡 **TL;DR**: `npm i -g botmux` → `botmux setup` to scan a QR code and create the app, pick a CLI, fill in the working directory → `botmux start` → `botmux autostart enable` → add the bot to a group and start chatting.

## Step 1 · Install

```bash
npm install -g botmux
```

Requires **Node.js ≥ 20**, with at least one AI coding CLI already installed and signed in locally (`claude` / `codex` / `cursor-agent` / `gemini` / `opencode` / `coco` / `agy`, etc.). Installing **tmux** (≥3.x) is recommended — once installed, session persistence is enabled automatically.

## Step 2 · Configure (`botmux setup`)

```bash
botmux setup
```

An interactive wizard; just follow the prompts:

1. **New config**: type `1` and press Enter. (If you already have a config, type `2` to add a bot.)
2. **Create a bot**:
   - Type `1` → **Create by QR code** (recommended): scan with Lark, and a PersonalAgent app is created automatically with the AppID/AppSecret saved to disk; event subscriptions and bot capabilities are pre-configured by default.
   - Type `2` → **Create manually**: go to the [Lark Open Platform](https://open.larkoffice.com/app) to create a custom enterprise app, then paste the AppID/AppSecret.
3. **Pick a CLI**: choose the CLI to onboard this time (e.g. choose `1` for Claude Code).
4. **Default working directory**: usually fill in the **parent directory** of your git projects (e.g. `~/projects`); it searches up to 3 levels down. Try not to use `~` (it would have to traverse too many folders).

> ✅ **Both Feishu (feishu.cn) and Lark (international, larksuite.com) are supported**: when creating the app by QR code, the tenant type is detected automatically; when pasting manually, you can choose it. You can mix both on the same machine.

> 🔧 **Creating by QR code auto-configures all permissions and publishes a version** — no manual steps needed. Only if you add `botmux setup --no-open-platform-auto` (skip auto-config) or create the app manually do you need to import the permission JSON yourself in the Open Platform (setup writes the full set to `~/.botmux/lark-scopes.json` and prints a one-click copy command) and create/publish a version; choosing availability "Visible to me only" gets auto-approved.

## Step 3 · Start

```bash
botmux start            # Start the daemon
botmux autostart enable # Start on boot (recommended; survives machine restarts, no sudo needed)
```

## Step 4 · Create a group and start chatting

1. Create a **topic group** in Lark (regular groups are also supported).
2. Group settings → Group bots → add the bot you just created.
3. Send a message directly in the group, and the bot responds automatically — it pops up a repository selection card, and once you pick a project the CLI launches in that directory.

You can also **DM the bot** to start chatting directly, or use `botmux dashboard` and switch to the Group Tab to create a group with one click.

## Not receiving messages? Self-check

PersonalAgent has subscriptions pre-configured, so normally you don't need to touch anything. If the bot **receives no messages at all**:

- **Event subscriptions**: Open Platform → Events & callbacks → should subscribe to `im.message.receive_v1` + `card.action.trigger`, with the delivery method set to "Long connection (WebSocket)", and the daemon should be running.
- **Bot capability**: Open Platform → App features → Bot should be enabled.

After confirming, run `botmux restart`. See [FAQ / Troubleshooting](/en/faq) for more.
