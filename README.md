# Badge Farmer

[Русская версия](README.ru.md)

A fork of [FrostyDeFreeze/twitch-badge-farmer](https://github.com/FrostyDeFreeze/twitch-badge-farmer),
focused on **channel watch-time badges and Twitch Drops**.

The original project collects global Twitch badges. This fork adds discovery of
rewards on followed channels and chooses what to watch using remaining watch
time, reward expiration and recent streaming history. You can pin a reward
that should receive as much eligible viewing time as possible.

## What this fork adds

- **Channel reward discovery.** Scans followed live channels, filters free eligible
  rewards and merges duplicates returned by Twitch's two reward APIs.
- **Automatic channel selection.** Recalculates the viewing order using remaining minutes,
  expiration, current stream age and estimated future airtime. Reports competing
  deadlines and rewards that are unlikely to finish in time.
- **Stream-duration estimates.** Reads public recent aggregates from
  [Lurkology](https://lurkology.com), caches them and exposes fallback estimates when
  statistics are missing. Estimates are not a published streamer schedule.
- **Pinned priority.** Keep a chosen reward's channel in a viewing slot whenever it
  is live and eligible. Change or clear the priority from the command line.
- **Up to two streams.** Independent playback sessions for different campaigns.
  Parallel credit is checked against Twitch counters; the secondary is suspended
  if it interferes with priority progress.
- **Visible progress and windows.** List followed channels, available rewards,
  earned/required minutes, opening/closing dates and the current plan; JSON supported.
- **Optional notifications.** An editable persistent Telegram progress card,
  Discord events and a generic HTTPS webhook. No notification destination is enabled
  until configured.
- **Persistent state.** Known offline rewards, public history caches and progress
  progress survive restarts. Reward collection is confirmed
  by Twitch rather than inferred from local elapsed time.

## Install

Download an archive from [this fork's releases](https://github.com/w11hxhx/twitch-badge-farmer/releases):

| Platform            | Archive                           |
| ------------------- | --------------------------------- |
| Windows x64         | `badge-farmer-windows-x64.zip`    |
| Linux x64           | `badge-farmer-linux-x64.tar.gz`   |
| macOS Apple Silicon | `badge-farmer-macos-arm64.tar.gz` |
| macOS Intel         | `badge-farmer-macos-x64.tar.gz`   |

Extract it and generate a config:

```sh
./badge-farmer --gen-token
```

On Windows use `badge-farmer.exe`. Complete Twitch authorization in your browser.
Existing valid configuration can be reused. Keep `config.json` private.

Add the following settings to the generated config:

```json
{
	"followDrops": true,
	"scheduler": {
		"maxConcurrentStreams": 2,
		"historyEnabled": true
	}
}
```

Start `./badge-farmer`. Set `maxConcurrentStreams` to `1` for one stream.

## Commands

```sh
./badge-farmer --channels
./badge-farmer --eligible-channels
./badge-farmer --plan
./badge-farmer --plan --json
./badge-farmer --set-priority "Reward name"
./badge-farmer --set-priority none
./badge-farmer --version
```

Every command accepts `--config /path/account.json`. `--channels` includes offline
follows. Lists and plans do not watch streams, claim rewards or send notifications.
A running service reloads a saved priority on its next scan. Times in lists are UTC.

## Notifications

Notifications are optional. Add only the destinations you want to your config:

```json
{
	"notifications": {
		"telegram": { "token": "123456:BOT_TOKEN", "chatId": "123456" },
		"discord": { "webhook": "https://discord.com/api/webhooks/123456/WEBHOOK_TOKEN" },
		"webhook": { "url": "https://example.com/private-hook" }
	}
}
```

Telegram updates a saved progress message and restores its ID after a restart.
Discord and HTTPS webhooks receive reward events. Test configured destinations:

```sh
./badge-farmer --test-notifications
```

## How it works

1. Checks followed channels for eligible free watch rewards.
2. Reads Twitch progress and combines duplicate reward entries.
3. Estimates remaining airtime using recent stream statistics from Lurkology.
4. Keeps a pinned reward active and selects other rewards by their deadlines.
5. Checks progress on each stream, switches stalled sessions and confirms rewards with Twitch.

The plan is refreshed as channels and progress change. Lurkology estimates are cached;
missing history uses an explicit fallback estimate. `--plan` shows the source and risk.

## Build from source

```sh
bun install --frozen-lockfile
bun run typecheck
bun test src
bun run format:check
bun run build
```

Requires Bun 1.4.3 or newer. Output: `dist/badge-farmer` (Windows: `.exe`).

## Scope and limitations

The followed-channel mode supports ordinary watch-time Drops and single-stage WATCH
reward groups. Paid rewards are skipped. Set `followDrops: false` to use the original
catalog-based global badge collector, including its multi-day progression support.

No planner can guarantee every deadline: a channel can stay offline, end early,
or Twitch can decline concurrent credit. Two opened streams do not guarantee two
credited streams. The plan exposes these risks and assumes one effective slot until
parallel progress is confirmed. Run one farmer process per account; other viewers
or miners on that account can affect credit.

The project uses Twitch's unofficial/internal reward APIs, which can change.
No purchases, subscriptions or Bits spending are performed.

## Upstream and license

Based on **[Twitch Badge Farmer by FrostyDeFreeze](https://github.com/FrostyDeFreeze/twitch-badge-farmer)**.
This repository is a community fork; channel discovery and scheduling are additions
to the original work. [MIT license](LICENSE).
