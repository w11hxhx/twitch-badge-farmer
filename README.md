# Badge Farmer

[Русская версия](README.ru.md)

A fork of [FrostyDeFreeze/twitch-badge-farmer](https://github.com/FrostyDeFreeze/twitch-badge-farmer)
for collecting creator channel badges awarded for watching Twitch streams.

The program finds available badges on followed channels, tracks their progress through
Twitch and switches channels as rewards are completed. You can choose a priority badge
or channel. Viewing order also takes remaining watch time, reward availability and
recent stream history from [Lurkology](https://lurkology.com) into account.

## Installation

Download an archive from [Releases](https://github.com/w11hxhx/twitch-badge-farmer/releases)
and extract it into a folder for the program and its configuration.

| System              | Download                          |
| ------------------- | --------------------------------- |
| Windows x64         | `badge-farmer-windows-x64.zip`    |
| Linux x64           | `badge-farmer-linux-x64.tar.gz`   |
| macOS Apple Silicon | `badge-farmer-macos-arm64.tar.gz` |
| macOS Intel         | `badge-farmer-macos-x64.tar.gz`   |

Open a terminal in that folder and sign in to Twitch:

```powershell
.\badge-farmer.exe --gen-token
```

On Linux or macOS:

```sh
./badge-farmer --gen-token
```

Follow the authorization instructions in your browser. The program creates `config.json`.
Keep this file private: it contains your access token.

## Usage

Start `badge-farmer.exe` on Windows or `./badge-farmer` on Linux and macOS.
Press **Ctrl+C** to stop. Progress is restored from Twitch and the saved state on restart.

| Command                       | Description                                            |
| ----------------------------- | ------------------------------------------------------ |
| `--list`                      | List available badges without watching                 |
| `--channels`                  | List followed channels, including offline channels     |
| `--eligible-channels`         | Show badges, channels, progress and availability dates |
| `--plan`                      | Show the current viewing order                         |
| `--set-priority "Badge name"` | Prioritize a badge by name or ID                       |
| `--set-priority none`         | Clear the badge priority                               |
| `--gen-token`                 | Authorize your Twitch account                          |
| `--help`                      | Show all options                                       |

Use `--config account.json` for another configuration and `--json` for machine-readable
channel lists or plans.

Followed channels are checked every three minutes. New eligible badges are added;
completed, expired or unavailable rewards and unfollowed channels leave the queue.
Manually added channels remain included. No more than two streams are watched at once;
parallel progress is checked against Twitch counters.

## Notifications and Telegram controls

Notifications are optional. Add only the destinations you need to `config.json`:

```json
{
	"notifications": {
		"telegram": { "token": "123456:BOT_TOKEN", "chatId": "123456", "controls": true },
		"discord": { "webhook": "https://discord.com/api/webhooks/123456/WEBHOOK_TOKEN" },
		"webhook": { "url": "https://example.com/notifications" }
	}
}
```

Telegram edits a persistent progress message. With `controls: true`, its buttons let
you add or exclude badge channels and choose a priority badge or channel.
Commands are accepted only from the owner of the configured private chat:

```text
/add channel_name
/remove channel_name
/priority_badge Badge name
/priority_channel channel_name
/channels
/menu
/cancel
```

Use `none` to clear a priority. Run `--test-notifications` to check configured destinations.

## Manual installation

Requires [Bun](https://bun.sh) 1.4.3 or newer.

```sh
bun install --frozen-lockfile
bun run gen-token
bun start
```

To check and build the executable:

```sh
bun run typecheck
bun test src
bun run format:check
bun run build
```

The result is `dist/badge-farmer` (`.exe` on Windows).

## Limitations

Only badges awarded for watching are collected. Paid rewards and subscription requirements
are skipped. Twitch confirms badge ownership and progress; local viewing time alone does
not count as confirmation. Stream history estimates do not guarantee reward completion.

The program uses Twitch's internal APIs, which may change. Run one instance per account.

## Original project

Based on [Twitch Badge Farmer by FrostyDeFreeze](https://github.com/FrostyDeFreeze/twitch-badge-farmer).
[MIT license](LICENSE).
