import type { Candidate } from './follow-drops.ts'
import type { StreamHistory } from './history.ts'

export interface SchedulerSettings {
	priorityReward?: string
	maxConcurrentStreams?: 1 | 2
	historyEnabled?: boolean
}
export interface PlanRow {
	id: string
	reward: string
	channel: string
	priority: boolean
	live: boolean
	watchedMinutes: number
	requiredMinutes: number
	remainingMinutes: number
	deadlineUTC: string | null
	averageStreamMinutes: number
	estimatedLiveMinutes: number
	estimatedFinishUTC: string | null
	slackMinutes: number
	risk: 'unknown' | 'likely' | 'tight' | 'unlikely' | 'expired'
	source: string
	selected: boolean
	reason: string
}
export function rewardKey(item: Candidate) {
	return item.stream.drop.campaignId + ':' + item.stream.drop.id
}
export function isPriority(item: Candidate, priority?: string) {
	if (!priority) return false
	const query = priority.trim().toLowerCase()
	return [rewardKey(item), item.stream.drop.id, ...(item.badgeIds ?? []), item.title].some(value => value.toLowerCase() === query)
}

export function planSchedule(
	items: Candidate[],
	history: (login: string) => StreamHistory,
	settings: SchedulerSettings,
	now = Date.now(),
	verifiedSlots = 1
) {
	const scored = items.map(item => {
		const stats = history(item.stream.user_login)
		const remaining = Math.max(0, item.minutes - item.watched)
		const horizon = Math.max(0, (item.end - now) / 60000)
		const age = item.stream.started_at ? Math.max(0, (now - Date.parse(item.stream.started_at)) / 60000) : 0
		const currentBudget = item.live !== false ? Math.min(horizon, Math.max(30, stats.averageMinutes - age, stats.averageMinutes * 0.2)) : 0
		const futureBudget = Number.isFinite(horizon)
			? (Math.max(0, horizon - currentBudget) / 1440) * stats.streamsPerDay * stats.averageMinutes * 0.8
			: Infinity
		const capacity = Math.min(horizon, currentBudget + futureBudget)
		const duty = Math.min(1, ((stats.streamsPerDay * stats.averageMinutes) / 1440) * 0.8)
		const calendarCost = remaining <= currentBudget ? remaining : currentBudget + (remaining - currentBudget) / Math.max(0.01, duty)
		const slack = capacity - remaining
		const latestStart = item.end - calendarCost * 60000
		const risk: PlanRow['risk'] =
			horizon <= 0
				? 'expired'
				: remaining > horizon || slack < 0
					? 'unlikely'
					: stats.source === 'fallback'
						? 'unknown'
						: slack < Math.max(30, remaining * 0.25)
							? 'tight'
							: 'likely'
		const row: PlanRow = {
			id: rewardKey(item),
			reward: item.title,
			channel: item.stream.user_login,
			priority: isPriority(item, settings.priorityReward),
			live: item.live !== false,
			watchedMinutes: item.watched,
			requiredMinutes: item.minutes,
			remainingMinutes: remaining,
			deadlineUTC: Number.isFinite(item.end) ? new Date(item.end).toISOString() : null,
			averageStreamMinutes: Math.round(stats.averageMinutes),
			estimatedLiveMinutes: Number.isFinite(capacity) ? Math.round(capacity) : 0,
			estimatedFinishUTC: Number.isFinite(calendarCost) ? new Date(now + calendarCost * 60000).toISOString() : null,
			slackMinutes: Number.isFinite(slack) ? Math.round(slack) : 0,
			risk,
			source: stats.source,
			selected: false,
			reason: ''
		}
		return { item, row, latestStart }
	})
	scored.sort(
		(a, b) =>
			Number(b.row.priority) - Number(a.row.priority) ||
			Number(['unlikely', 'expired'].includes(a.row.risk)) - Number(['unlikely', 'expired'].includes(b.row.risk)) ||
			a.latestStart - b.latestStart ||
			a.item.end - b.item.end ||
			a.row.remainingMinutes - b.row.remainingMinutes ||
			a.row.channel.localeCompare(b.row.channel)
	)
	const selected: Candidate[] = []
	const channels = new Set<string>(),
		campaigns = new Set<string>()
	const slots = settings.maxConcurrentStreams ?? 2
	for (const value of scored) {
		if (
			value.row.remainingMinutes === 0 ||
			value.item.live === false ||
			value.item.end <= now ||
			selected.length >= slots ||
			channels.has(value.item.stream.user_id) ||
			campaigns.has(value.item.stream.drop.campaignId)
		)
			continue
		selected.push(value.item)
		channels.add(value.item.stream.user_id)
		campaigns.add(value.item.stream.drop.campaignId)
		value.row.selected = true
		value.row.reason = value.row.priority
			? 'Pinned priority: keep watching whenever eligible and live'
			: 'Earliest estimated last safe start, considering remaining work and stream availability'
	}
	// Report shared capacity separately: individual feasibility does not imply that every deadline can be met.
	const unique = new Map<string, (typeof scored)[number]>()
	for (const value of scored) if (!unique.has(value.row.id)) unique.set(value.row.id, value)
	const deadlines = [...unique.values()].filter(v => Number.isFinite(v.item.end) && v.item.end > now).sort((a, b) => a.item.end - b.item.end)
	const warnings: string[] = []
	for (let index = 0; index < deadlines.length; index++) {
		const byChannel = new Map<string, number>()
		for (const value of deadlines.slice(0, index + 1))
			byChannel.set(value.row.channel, Math.max(byChannel.get(value.row.channel) ?? 0, value.row.remainingMinutes))
		const work = [...byChannel.values()].reduce((sum, value) => sum + value, 0)
		const available = ((deadlines[index]!.item.end - now) / 60000) * Math.min(slots, verifiedSlots)
		if (work > available)
			warnings.push(
				`Insufficient shared viewing capacity before ${deadlines[index]!.row.deadlineUTC}: ${Math.ceil(work)} min needed, ${Math.floor(available)} min available`
			)
	}
	if (slots === 2 && verifiedSlots < 2)
		warnings.push('Second stream is experimental; deadline feasibility assumes one slot until Twitch confirms parallel progress')
	if (settings.priorityReward && !scored.some(value => value.row.priority && value.row.live))
		warnings.push('Priority reward is not currently eligible and live; other rewards use the available slots')
	return { selected, rows: scored.map(value => value.row), warnings: [...new Set(warnings)], assumedSlots: Math.min(slots, verifiedSlots) }
}
