# Deadline planner and followed-channel rewards

[Русский](FOLLOW-DROPS.ru.md) · [Release notes](RELEASE_NOTES.md)

This fork discovers free watch rewards on followed live channels. Both Twitch Drops
and single-stage WATCH reward groups are supported. Duplicate campaign/reward IDs
from the two Twitch APIs are merged, using authoritative reward-group progress.
Paid, locked, owned and expired rewards are excluded. Multi-day progression remains
available in the original global-badge mode (`followDrops: false`).

## Setup and commands

Download a [release](https://github.com/w11hxhx/twitch-badge-farmer/releases), extract
it, and run `./badge-farmer --gen-token` (Windows: `badge-farmer.exe`). Reuse an
existing valid config if available. Add these settings to your private config:

```json
{
	"followDrops": true,
	"scheduler": {
		"maxConcurrentStreams": 2,
		"historyEnabled": true,
		"priorityReward": "Exact reward name or campaignId:rewardId"
	}
}
```

Omit `priorityReward` for automatic scheduling. Run one process per account.
All commands accept `--config /path/account.json`.

```sh
./badge-farmer
./badge-farmer --channels
./badge-farmer --eligible-channels
./badge-farmer --plan
./badge-farmer --plan --json
./badge-farmer --set-priority "Exact reward name"
./badge-farmer --set-priority none
./badge-farmer --version
```

`--channels` lists every followed channel, online and offline. `--eligible-channels`
(alias `--scan-follows`) shows distinct live rewards, channels, progress and UTC
opening/closing timestamps; missing dates are null. `--plan` includes previously
discovered offline rewards, remaining minutes, average stream duration, predicted
airtime, completion estimates, risks, slots and selection reasons. JSON includes
warnings. Listing does not watch, claim, send notifications or write planner caches.

`--set-priority` atomically preserves configuration ownership and private permissions.
A running service reloads it at its next scan, normally within three minutes plus
scan time. Use an exact name, reward ID, campaignId:rewardId or badge set ID.
A live eligible priority retains a slot until completion, failure or loss of
eligibility. When it is offline, other rewards use the slots.

## Forecast and concurrency

Non-priority rewards are ranked by estimated last safe start: deadline, remaining
watch time, current stream age and expected future airtime. Achievable deadlines
are preferred over already infeasible ones, unless explicitly pinned.

Public 30-day aggregates from `https://lurkology.com/CHANNEL/streams` supply average
session length and streams/day. Requests need no authentication, are bounded,
limited to three in parallel and cached six hours. The forecast reserves a 20%
airtime margin. A cache older than seven days becomes an explicit fallback; source
and uncertainty are visible in the plan. An ETA is not a streamer-announced schedule.

At most two independent playback sessions run on different channels/campaigns.
Twitch does not guarantee simultaneous Drops credit. Until both server counters
increase, shared deadline checks assume **one** effective slot. A three-minute
priority stall suspends the secondary for 30 minutes. A five-minute stall replans
the affected stream and can also suspend parallel viewing. A new pair is verified
again; two channels of one campaign never double count time.

Meeting every deadline cannot be guaranteed when streams end early or are offline,
rewards compete for airtime, or Twitch refuses parallel credit. The planner exposes
per-reward risk and conflicting shared deadlines instead of promising unavailable time.

## Optional notifications and status integration

Add only desired destinations to your config. Defaults send nothing:

```json
{
	"notifications": {
		"telegram": { "token": "123456:BOT_TOKEN", "chatId": "123456" },
		"discord": { "webhook": "https://discord.com/api/webhooks/123456/WEBHOOK_TOKEN" },
		"webhook": { "url": "https://example.com/private-hook" }
	}
}
```

Telegram edits one persistent progress card for both active sessions. Its message
ID survives restarts; unchanged text is skipped, deleted cards recreated, and
HTTP 429 respects retry_after. Event messages are separate. Discord/HTTPS receive
events, not minute-by-minute progress. Explicit delivery test: `--test-notifications`.

Private atomic sidecars beside the config:

- `.history.state.json`: public stream aggregates and timestamps.
- `.planner.state.json`: known rewards, including offline channels, and completions.
- `.status.json`: account, active channels, progress, priority, estimates and warnings.
- `.notifications.state.json`: Telegram message ID/destination fingerprint, no token.

External points/badge dashboards may read `.status.json`. No personal VPS bridge or
Telegram credentials are part of this repository. Only Twitch confirms collection.

## Build and update

```sh
bun install --frozen-lockfile
bun run typecheck
bun test src
bun run format:check
bun run build
```

Archives target Windows x64, Linux x64, macOS arm64 and macOS x64, with SHA-256.
Stop the old instance before replacing its binary; preserve config/state for rollback.
Existing authorization can be reused while valid.
