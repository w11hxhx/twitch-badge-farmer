import type { Campaign, Drop, SelectedStream } from './types.ts'
import type { Twitch } from './twitch.ts'
import { Notifications } from './notifications.ts'

export function eligibleDrop(campaign: Campaign, drop: Drop, now = Date.now()) {
	return (
		(!campaign.startAt || Date.parse(campaign.startAt) <= now) &&
		(!campaign.endAt || Date.parse(campaign.endAt) > now) &&
		Date.parse(drop.startAt) <= now &&
		Date.parse(drop.endAt) > now &&
		drop.requiredMinutesWatched > 0 &&
		!drop.requiredSubs &&
		!drop.requiredTurboSubs &&
		drop.self?.hasPreconditionsMet !== false &&
		!drop.self?.isClaimed
	)
}

interface Candidate {
	stream: SelectedStream
	title: string
	minutes: number
	watched: number
	end: number
	start: number
	claimed: boolean
	instance?: string | null | undefined
}

export function mergeCandidates(items: Candidate[]) {
	const result = new Map<string, Candidate>()
	for (const item of items) {
		const ref = item.stream.drop
		const key = [item.stream.user_id, ref.campaignId, ref.id].join(':')
		const previous = result.get(key)
		if (!previous) {
			result.set(key, item)
			continue
		}
		const preferred = ref.kind === 'reward-group' ? item : previous
		const advertised = ref.kind === 'reward-group' ? previous : item
		result.set(key, {
			...preferred,
			title: advertised.title,
			start: Number.isFinite(preferred.start) ? preferred.start : advertised.start,
			end: Math.min(item.end, previous.end)
		})
	}
	return [...result.values()]
}

export function rewardRows(items: Candidate[]) {
	const grouped = new Map<
		string,
		{
			reward: string
			type: string
			channels: string[]
			watchedMinutes: number
			requiredMinutes: number
			openedUTC: string | null
			closesUTC: string | null
		}
	>()
	for (const item of mergeCandidates(items)) {
		const ref = item.stream.drop
		const key = [ref.campaignId, ref.id].join(':')
		let row = grouped.get(key)
		if (!row) {
			row = {
				reward: item.title,
				type: ref.kind === 'reward-group' ? 'WATCH reward group' : 'Drop',
				channels: [],
				watchedMinutes: item.watched,
				requiredMinutes: item.minutes,
				openedUTC: Number.isFinite(item.start) ? new Date(item.start).toISOString() : null,
				closesUTC: Number.isFinite(item.end) ? new Date(item.end).toISOString() : null
			}
			grouped.set(key, row)
		}
		if (!row.channels.includes(item.stream.user_login)) row.channels.push(item.stream.user_login)
		row.watchedMinutes = Math.max(row.watchedMinutes, item.watched)
	}
	return [...grouped.values()].map(row => ({ ...row, channels: row.channels.sort() }))
}

export function progressMessage(item: Candidate, status = 'Просмотр') {
	const percent = Math.min(100, Math.floor((item.watched / item.minutes) * 100))
	const date = (value: number) =>
		Number.isFinite(value) ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Twitch не указал'
	return `${status}\n${item.title}\nhttps://www.twitch.tv/${item.stream.user_login}\nПрогресс: ${item.watched}/${item.minutes} мин (${percent}%)\nОсталось смотреть: ${Math.max(0, item.minutes - item.watched)} мин\nОткрылась: ${date(item.start)}\nЗакроется: ${date(item.end)}`
}

// Stable round-robin by channel: no special treatment for pwgood or viewer count.
export function fairChoice<T extends { stream: { user_login: string } }>(items: T[], previous: string) {
	const sorted = [...items].sort((a, b) => a.stream.user_login.localeCompare(b.stream.user_login))
	return sorted.find(item => item.stream.user_login > previous) ?? sorted[0]
}

export class FollowDrops {
	scanWarnings: string[] = []
	private candidates: Candidate[] = []
	private active: Candidate | undefined
	private nextScan = 0
	private nextProgress = 0
	private lastProgress = Date.now()
	private previous = ''
	private selectedAt = 0
	private cooldown = new Map<string, number>()
	private notifications: Notifications
	constructor(
		private twitch: Twitch,
		notificationStatePath?: string
	) {
		this.notifications = new Notifications(twitch.config.notifications, fetch, notificationStatePath)
	}
	rows() {
		return rewardRows(this.candidates)
	}
	async updateProgress(item: Candidate, status?: string) {
		for (const error of await this.notifications.send('progress', progressMessage(item, status))) this.twitch.log.warn('Notifications | ' + error)
	}
	async notify(event: string, message: string) {
		this.twitch.log.info(message)
		for (const error of await this.notifications.send(event, message)) this.twitch.log.warn('Notifications | ' + error)
	}
	async scan() {
		this.scanWarnings = []
		const live = await this.twitch.followedLive()
		const inventory = await this.twitch.inventory()
		const owned = await this.twitch.badges()
		const candidates: Candidate[] = []
		let pulse = Date.now()
		for (const channel of live) {
			if (this.active && Date.now() - pulse >= 20_000) {
				await this.twitch.watch(this.active.stream)
				pulse = Date.now()
			}
			try {
				const task = { channels: [channel], categoryIds: [] }
				const stream = (await this.twitch.streams(task))[0]
				if (!stream) continue
				const data = await this.twitch.gql('DropsHighlightService_AvailableDrops', { channelID: channel.id })
				for (const campaign of data.channel?.viewerDropCampaigns ?? []) {
					if (campaign.game && campaign.game.id !== stream.game_id) continue
					for (const advertised of campaign.timeBasedDrops ?? []) {
						const progress = inventory.find(c => c.id === campaign.id)?.timeBasedDrops?.find(d => d.id === advertised.id)
						const drop = { ...advertised, self: progress?.self ?? advertised.self ?? null }
						if (!eligibleDrop(campaign, drop)) continue
						candidates.push({
							stream: { ...stream, drop: { id: drop.id, campaignId: campaign.id } },
							title:
								drop.benefitEdges
									?.map(e => e.benefit?.name)
									.filter(Boolean)
									.join(', ') || drop.id,
							minutes: drop.requiredMinutesWatched,
							watched: drop.self?.currentMinutesWatched ?? 0,
							end: Math.min(Date.parse(drop.endAt), campaign.endAt ? Date.parse(campaign.endAt) : Infinity),
							start: Math.max(Date.parse(drop.startAt), campaign.startAt ? Date.parse(campaign.startAt) : -Infinity),
							claimed: false,
							instance: drop.self?.dropInstanceID
						})
					}
				}
				// Channel watch badges use the newer reward-group API, outside the global badge catalog.
				for (const campaign of (await this.twitch.channelCampaigns(channel.id)) ?? []) {
					if (
						(campaign.startAt && Date.parse(campaign.startAt) > Date.now()) ||
						(campaign.endAt && Date.parse(campaign.endAt) <= Date.now())
					)
						continue
					for (const group of campaign.rewardGroups ?? []) {
						const req = group.progressCriteria?.requirements
						const self = inventory.find(c => c.id === campaign.id)?.rewardGroups?.find(g => g.id === group.id)?.self ?? group.self
						const badges = (group.rewards ?? [])
							.flatMap(r => [r, ...(r.pool?.rewards ?? [])])
							.flatMap(r => {
								const badge = r.dropDetail?.badge
								return badge?.setID && badge.version != null ? [badge.setID + ':' + badge.version] : []
							})
						if (badges.length && badges.every(badge => owned.has(badge))) continue
						if (
							group.progressCriteria?.requirementType !== 'WATCH' ||
							!req?.minutesWatched ||
							req.subs ||
							req.turboSubs ||
							group.track ||
							group.lane ||
							(group.progressCriteria?.repeatableConfig?.repeatableTimes ?? 1) > 1 ||
							self?.hasPreconditionsMet !== true ||
							['CLAIMED', 'FULFILLED'].includes(self?.status ?? '') ||
							(self?.nextEligibleAt && Date.parse(self.nextEligibleAt) > Date.now())
						)
							continue
						candidates.push({
							stream: { ...stream, drop: { id: group.id, campaignId: campaign.id, kind: 'reward-group' } },
							title: campaign.name
								? campaign.name + ' / WATCH'
								: badges.length
									? badges.map(badge => badge.replace(/:\d+$/, '')).join(', ')
									: 'WATCH reward ' + group.id,
							minutes: req.minutesWatched,
							watched: self?.currentMinutesWatched ?? 0,
							end: campaign.endAt ? Date.parse(campaign.endAt) : Infinity,
							start: campaign.startAt ? Date.parse(campaign.startAt) : NaN,
							claimed: false
						})
					}
				}
			} catch (error) {
				if (error instanceof Error && error.fatal) throw error
				this.twitch.log.warn('Drops scan unavailable | ' + channel.login)
				this.scanWarnings.push('Drops scan unavailable | ' + channel.login)
				if (error instanceof Error) this.twitch.log.debug(error.message)
			}
		}
		const merged = mergeCandidates(candidates)
		const seen = new Set(this.candidates.map(c => c.stream.drop.id))
		for (const item of merged) {
			if (!seen.has(item.stream.drop.id))
				await this.notify('available', 'Watch reward available | ' + item.stream.user_login + ' | ' + item.title)
			seen.add(item.stream.drop.id)
		}
		if (this.active) {
			const reference = this.active.stream.drop
			const campaign = inventory.find(c => c.id === reference.campaignId)
			const claimed =
				reference.kind === 'reward-group'
					? ['CLAIMED', 'FULFILLED'].includes(campaign?.rewardGroups?.find(g => g.id === reference.id)?.self?.status ?? '')
					: campaign?.timeBasedDrops?.find(d => d.id === reference.id)?.self?.isClaimed
			if (claimed) {
				await this.updateProgress(this.active, 'Награда получена')
				await this.notify('earned', 'Reward confirmed | ' + this.active.stream.user_login + ' | ' + this.active.title)
				this.active = undefined
			}
		}
		this.candidates = merged
		this.nextScan = Date.now() + 180_000
		this.twitch.log.info(
			`Follow Drops | ${live.length} live followed channels | ${new Set(merged.map(c => c.stream.user_id)).size} eligible channels | ${this.rows().length} unique rewards | ${merged.length} channel/reward pairs`
		)
	}
	async persist() {} // Twitch inventory is the source of progress; no credentials or inferred rewards in state.
	interrupt() {
		this.twitch.playback = null
		this.active = undefined
		this.nextScan = 0
	}
	async step() {
		if (Date.now() >= this.nextScan) await this.scan()
		if (this.active && Date.now() - this.selectedAt >= 1_800_000) {
			this.active = undefined
			this.twitch.playback = null
		}
		if (this.active && !this.candidates.some(c => c.stream.id === this.active!.stream.id && c.stream.drop.id === this.active!.stream.drop.id))
			this.active = undefined
		if (!this.active) {
			this.active = fairChoice(
				this.candidates.filter(c => c.end > Date.now() && (this.cooldown.get(c.stream.user_id) ?? 0) <= Date.now()),
				this.previous
			)
			if (!this.active) return 60_000
			this.previous = this.active.stream.user_login
			this.selectedAt = Date.now()
			this.lastProgress = Date.now()
			this.nextProgress = 0
			await this.notify('watching', 'Watching | ' + this.previous + ' | ' + this.active.title)
			await this.updateProgress(this.active)
		}
		const active = this.active
		if (Date.now() >= this.nextProgress) {
			const inventory = await this.twitch.inventory()
			const reference = active.stream.drop
			let group =
				reference.kind === 'reward-group'
					? inventory.find(c => c.id === reference.campaignId)?.rewardGroups?.find(g => g.id === reference.id)
					: undefined
			if (reference.kind === 'reward-group' && !group) {
				this.twitch.channelRewards.delete(active.stream.user_id)
				group = (await this.twitch.channelCampaigns(active.stream.user_id))
					?.find(c => c.id === reference.campaignId)
					?.rewardGroups?.find(g => g.id === reference.id)
			}
			const progress =
				reference.kind === 'reward-group'
					? group?.self
						? {
								currentMinutesWatched: group.self.currentMinutesWatched ?? 0,
								requiredMinutesWatched: group.progressCriteria?.requirements?.minutesWatched ?? active.minutes,
								isClaimed: ['CLAIMED', 'FULFILLED'].includes(group.self.status),
								dropInstanceID: null
							}
						: null
					: await this.twitch.dropProgress(reference, '', inventory)
			this.nextProgress = Date.now() + 60_000
			if (progress) {
				if (progress.currentMinutesWatched > active.watched) this.lastProgress = Date.now()
				active.watched = progress.currentMinutesWatched
				active.minutes = progress.requiredMinutesWatched
				await this.updateProgress(active, progress.isClaimed ? 'Награда получена' : 'Просмотр')
				this.twitch.log.info(`Progress | ${this.previous} | ${active.watched}/${progress.requiredMinutesWatched} min`)
				if (progress.isClaimed) {
					await this.notify('earned', 'Reward confirmed | ' + this.previous + ' | ' + active.title)
					this.candidates = this.candidates.filter(c => c.stream.drop.id !== active.stream.drop.id)
					this.active = undefined
					return 0
				}
				if (active.watched >= progress.requiredMinutesWatched && active.stream.drop.kind !== 'reward-group' && progress.dropInstanceID) {
					await this.twitch.claimDrop(progress.dropInstanceID)
					await this.updateProgress(active, 'Запрошено получение, ожидаю подтверждения Twitch')
					await this.notify('claim', 'Reward claim submitted; awaiting inventory confirmation | ' + active.title)
					return 20_000
				}
			}
		}
		if (Date.now() - this.lastProgress >= 300_000) {
			await this.updateProgress(active, 'Прогресс остановился — переключаю канал')
			await this.notify('stalled', 'No confirmed progress for 5 min | ' + this.previous + ' | Switching channel')
			this.cooldown.set(active.stream.user_id, Date.now() + 300_000)
			this.active = undefined
			this.twitch.playback = null
			return 0
		}
		try {
			await this.twitch.watch(active.stream)
		} catch (error) {
			this.cooldown.set(active.stream.user_id, Date.now() + 180_000)
			this.active = undefined
			throw error
		}
		return 20_000
	}
}
