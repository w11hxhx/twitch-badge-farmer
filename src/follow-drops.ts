import type { SelectedStream } from './types.ts'
import type { Twitch } from './twitch.ts'
import { Notifications } from './notifications.ts'
import { Histories } from './history.ts'
import { isPriority, planSchedule, rewardKey } from './scheduler.ts'
import { readConfig, validateConfig } from './config.ts'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { TelegramControl } from './telegram-control.ts'

export interface Candidate {
	stream: SelectedStream
	title: string
	minutes: number
	watched: number
	end: number
	start: number
	claimed: boolean
	live?: boolean
	badgeIds?: string[]
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
			start:
				Number.isFinite(preferred.start) && Number.isFinite(advertised.start)
					? Math.max(preferred.start, advertised.start)
					: Number.isFinite(preferred.start)
						? preferred.start
						: advertised.start,
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
				type: 'Channel badge',
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

export class FollowDrops {
	scanWarnings: string[] = []
	private candidates: Candidate[] = []
	private sessions = new Map<
		string,
		{ item: Candidate; playback: Twitch['playback']; lastProgress: number; nextProgress: number; advancedAt: number; startedAt: number }
	>()
	private known = new Map<string, Candidate>()
	private completed = new Map<string, Candidate>()
	private loaded = false
	private nextPlan = 0
	private parallelBlockedUntil = 0
	private verifiedSlots = 1
	private histories: Histories
	private nextScan = 0
	private cooldown = new Map<string, number>()
	private notifications: Notifications
	private controls?: TelegramControl
	constructor(
		private twitch: Twitch,
		notificationStatePath?: string,
		private configPath?: string,
		readOnly = false
	) {
		this.notifications = new Notifications(twitch.config.notifications, fetch, notificationStatePath)
		this.histories = new Histories(configPath ? configPath + '.history.state.json' : undefined, fetch, readOnly)
		const telegram = twitch.config.notifications?.telegram
		if (!readOnly && configPath && telegram?.controls)
			this.controls = new TelegramControl(
				telegram.token,
				[{ path: configPath, chatId: telegram.chatId }],
				configPath + '.telegram-control.json',
				fetch,
				async () => {
					this.nextScan = 0
					this.nextPlan = 0
				}
			)
	}
	rows() {
		return rewardRows(this.candidates)
	}
	async updateProgress(item: Candidate, status?: string) {
		const parts = [...this.sessions.values()]
			.filter(session => rewardKey(session.item) !== rewardKey(item))
			.map(session => progressMessage(session.item))
		parts.unshift(progressMessage(item, status))
		for (const error of await this.notifications.send('progress', '[' + this.twitch.config.login + ']\n' + parts.join('\n\n')))
			this.twitch.log.warn('Notifications | ' + error)
	}
	async notify(event: string, message: string) {
		this.twitch.log.info(message)
		for (const error of await this.notifications.send(event, message)) this.twitch.log.warn('Notifications | ' + error)
	}
	async scan() {
		await this.loadKnown()
		if (this.configPath) {
			const fresh = validateConfig(await readConfig(this.configPath))
			this.twitch.config.scheduler = fresh.scheduler ?? {}
			if (fresh.channels) this.twitch.config.channels = fresh.channels
			else delete this.twitch.config.channels
		}
		this.scanWarnings = []
		for (const [key, item] of this.known) if (item.stream.drop.kind !== 'reward-group' || !item.badgeIds?.length) this.known.delete(key)
		const excludedChannels = new Set(this.twitch.config.channels?.excluded ?? [])
		for (const [key, item] of this.known) if (excludedChannels.has(item.stream.user_login)) this.known.delete(key)
		for (const [key, session] of this.sessions) if (excludedChannels.has(session.item.stream.user_login)) this.sessions.delete(key)
		const channels = [...(await this.twitch.followedLive()), ...(this.twitch.config.channels?.added ?? [])]
		const live = [...new Map(channels.filter(c => !excludedChannels.has(c.login)).map(c => [c.id, c])).values()]
		const addedIds = new Set(this.twitch.config.channels?.added.map(c => c.id) ?? [])
		for (const [key, item] of this.known)
			if (this.twitch.followedIds && !this.twitch.followedIds.has(item.stream.user_id) && !addedIds.has(item.stream.user_id))
				this.known.delete(key)
		const inventory = await this.twitch.inventory()
		const owned = await this.twitch.badges()
		const candidates: Candidate[] = []
		const scanned = new Set<string>()
		const excluded = new Set<string>()
		let pulse = Date.now()
		for (const channel of live) {
			if (this.sessions.size && Date.now() - pulse >= 20_000) {
				for (const session of [...this.sessions.values()]) {
					try {
						await this.watchSession(session)
					} catch (error) {
						if (error instanceof Error && (error.fatal || this.twitch.signal?.aborted)) throw error
						this.sessions.delete(session.item.stream.user_id)
						this.cooldown.set(session.item.stream.user_id, Date.now() + 180000)
					}
				}
				pulse = Date.now()
			}
			try {
				const task = { channels: [channel], categoryIds: [] }
				const stream = (await this.twitch.streams(task))[0]
				if (!stream) continue
				// Channel watch badges use the newer reward-group API, outside the global badge catalog.
				this.twitch.channelRewards.delete(channel.id)
				const campaigns = await this.twitch.channelCampaigns(channel.id)
				if (campaigns === null) continue
				for (const campaign of campaigns) {
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
						const identity = [channel.id, campaign.id, group.id].join(':')
						if (badges.length && badges.every(badge => owned.has(badge))) {
							excluded.add(identity)
							continue
						}
						if (
							!badges.length ||
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
						) {
							excluded.add(identity)
							continue
						}
						candidates.push({
							stream: { ...stream, drop: { id: group.id, campaignId: campaign.id, kind: 'reward-group' } },
							title: campaign.name
								? campaign.name
								: badges.length
									? badges.map(badge => badge.replace(/:\d+$/, '')).join(', ')
									: 'WATCH reward ' + group.id,
							minutes: req.minutesWatched,
							watched: self?.currentMinutesWatched ?? 0,
							end: campaign.endAt ? Date.parse(campaign.endAt) : Infinity,
							start: campaign.startAt ? Date.parse(campaign.startAt) : NaN,
							claimed: false,
							live: true,
							badgeIds: badges
						})
					}
				}
				scanned.add(channel.id)
			} catch (error) {
				if (error instanceof Error && error.fatal) throw error
				this.twitch.log.warn('Badge scan unavailable | ' + channel.login)
				this.scanWarnings.push('Badge scan unavailable | ' + channel.login)
				if (error instanceof Error) this.twitch.log.debug(error.message)
			}
		}
		const merged = mergeCandidates(candidates).filter(
			item => !excluded.has([item.stream.user_id, item.stream.drop.campaignId, item.stream.drop.id].join(':'))
		)
		const seen = new Set(this.candidates.map(c => c.stream.drop.id))
		for (const item of merged) {
			if (!seen.has(item.stream.drop.id))
				await this.notify('available', 'Watch reward available | ' + item.stream.user_login + ' | ' + item.title)
			seen.add(item.stream.drop.id)
		}
		for (const session of this.sessions.values()) {
			const reference = session.item.stream.drop
			const campaign = inventory.find(c => c.id === reference.campaignId)
			const claimed = ['CLAIMED', 'FULFILLED'].includes(campaign?.rewardGroups?.find(g => g.id === reference.id)?.self?.status ?? '')
			if (claimed) {
				await this.earned(session.item)
			}
		}
		this.candidates = merged
		const available = new Set(merged.map(item => item.stream.user_id + ':' + rewardKey(item)))
		for (const [key, item] of this.known) if (scanned.has(item.stream.user_id) && !available.has(key)) this.known.delete(key)
		for (const item of this.known.values()) item.live = false
		for (const key of excluded) this.known.delete(key)
		for (const item of merged) this.known.set(item.stream.user_id + ':' + rewardKey(item), item)
		for (const [key, item] of this.known) if (item.end <= Date.now() || this.completed.has(rewardKey(item))) this.known.delete(key)
		await this.histories.refresh(
			[...new Set([...this.known.values()].map(item => item.stream.user_login))],
			this.twitch.config.scheduler?.historyEnabled ?? !!this.configPath
		)
		this.nextPlan = 0
		this.nextScan = Date.now() + 180_000
		this.twitch.log.info(
			`Followed badges | ${live.length} live followed channels | ${new Set(merged.map(c => c.stream.user_id)).size} eligible channels | ${this.rows().length} unique rewards | ${merged.length} channel/reward pairs`
		)
	}
	private async loadKnown() {
		if (this.loaded) return
		if (this.configPath) {
			try {
				const saved = JSON.parse(await readFile(this.configPath + '.planner.state.json', 'utf8')) as {
					account: string
					known: Candidate[]
					completed: Candidate[]
				}
				if (saved.account === this.twitch.config.id) {
					for (const item of saved.known ?? [])
						if (item.stream?.user_id && item.stream?.drop?.id && Number.isFinite(item.end) && item.end > Date.now() && item.minutes > 0)
							this.known.set(item.stream.user_id + ':' + rewardKey(item), { ...item, live: false })
					for (const item of saved.completed ?? []) if (item.stream?.drop?.id) this.completed.set(rewardKey(item), item)
				}
			} catch (error) {
				if (!(error instanceof Error) || error.code !== 'ENOENT') throw new Error('Planner | Could not read state')
			}
		}
		await this.histories.load()
		this.loaded = true
	}
	plan(now = Date.now()) {
		const settings = { ...this.twitch.config.scheduler }
		if (now < this.parallelBlockedUntil) settings.maxConcurrentStreams = 1
		return planSchedule(
			[...this.known.values()].map(item => ({ ...item, live: item.live !== false && (this.cooldown.get(item.stream.user_id) ?? 0) <= now })),
			login => this.histories.get(login, now),
			settings,
			now,
			this.verifiedSlots
		)
	}
	private async atomic(path: string, value: unknown) {
		const temporary = path + '.' + process.pid + '.tmp'
		await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
		await rename(temporary, path)
	}
	async persist() {
		if (!this.configPath) return
		await this.atomic(this.configPath + '.planner.state.json', {
			account: this.twitch.config.id,
			known: [...this.known.values()].filter(item => Number.isFinite(item.end)),
			completed: [...this.completed.values()].slice(-50)
		})
		const plan = this.plan()
		await this.atomic(this.configPath + '.status.json', {
			account: this.twitch.config.login,
			updatedAt: new Date().toISOString(),
			activeChannels: [...this.sessions.values()].map(s => s.item.stream.user_login),
			rewards: plan.rows,
			completed: [...this.completed.values()].map(item => ({
				reward: item.title,
				channel: item.stream.user_login,
				watchedMinutes: item.minutes,
				requiredMinutes: item.minutes
			})),
			warnings: plan.warnings,
			assumedSlots: plan.assumedSlots
		})
	}
	interrupt() {
		for (const session of this.sessions.values()) session.playback = null
		this.twitch.playback = null
		this.nextPlan = 0
	}
	private async watchSession(session: { item: Candidate; playback: Twitch['playback'] }) {
		const saved = this.twitch.playback
		this.twitch.playback = session.playback
		try {
			await this.twitch.watch(session.item.stream)
		} finally {
			session.playback = this.twitch.playback
			this.twitch.playback = saved
		}
	}
	private async earned(item: Candidate) {
		this.completed.set(rewardKey(item), { ...item, claimed: true })
		await this.updateProgress(item, 'Награда получена')
		await this.notify('earned', 'Reward confirmed | ' + item.stream.user_login + ' | ' + item.title)
		for (const [key, candidate] of this.known) if (rewardKey(candidate) === rewardKey(item)) this.known.delete(key)
		this.sessions.delete(item.stream.user_id)
		this.nextPlan = 0
	}
	async step() {
		await this.controls?.poll()
		if (Date.now() >= this.nextScan) await this.scan()
		if (Date.now() >= this.nextPlan) {
			const plan = this.plan()
			const selected = new Set(plan.selected.map(item => item.stream.user_id))
			for (const id of this.sessions.keys()) if (!selected.has(id)) this.sessions.delete(id)
			for (const item of plan.selected) {
				const previous = this.sessions.get(item.stream.user_id)
				if (previous && rewardKey(previous.item) === rewardKey(item)) {
					if (item.watched > previous.item.watched) {
						previous.lastProgress = Date.now()
						previous.advancedAt = Date.now()
					}
					previous.item = item
					continue
				}
				this.sessions.set(item.stream.user_id, {
					item,
					playback: null,
					lastProgress: Date.now(),
					nextProgress: 0,
					advancedAt: 0,
					startedAt: Date.now()
				})
				this.verifiedSlots = 1
				await this.notify(
					'watching',
					'Watching | ' +
						item.stream.user_login +
						' | ' +
						item.title +
						(isPriority(item, this.twitch.config.scheduler?.priorityReward) ? ' | PRIORITY' : ' | watching')
				)
				await this.updateProgress(item)
			}
			this.nextPlan = Date.now() + 60000
		}
		if (!this.sessions.size) {
			await this.persist()
			return 60000
		}
		const due = [...this.sessions.values()].filter(session => Date.now() >= session.nextProgress)
		const inventory = due.length ? await this.twitch.inventory() : []
		for (const session of [...this.sessions.values()]) {
			const item = session.item
			if (!this.sessions.has(item.stream.user_id)) continue
			if (Date.now() >= session.nextProgress) {
				const reference = item.stream.drop
				let group = inventory.find(c => c.id === reference.campaignId)?.rewardGroups?.find(g => g.id === reference.id)
				if (!group) {
					this.twitch.channelRewards.delete(item.stream.user_id)
					group = (await this.twitch.channelCampaigns(item.stream.user_id))
						?.find(c => c.id === reference.campaignId)
						?.rewardGroups?.find(g => g.id === reference.id)
				}
				const progress = group?.self
					? {
							currentMinutesWatched: group.self.currentMinutesWatched ?? 0,
							requiredMinutesWatched: group.progressCriteria?.requirements?.minutesWatched ?? item.minutes,
							isClaimed: ['CLAIMED', 'FULFILLED'].includes(group.self.status)
						}
					: null
				session.nextProgress = Date.now() + 60000
				if (progress) {
					if (progress.currentMinutesWatched > item.watched) {
						session.lastProgress = Date.now()
						session.advancedAt = Date.now()
					}
					item.watched = progress.currentMinutesWatched
					item.minutes = progress.requiredMinutesWatched
					this.known.set(item.stream.user_id + ':' + rewardKey(item), item)
					this.twitch.log.info(`Progress | ${item.stream.user_login} | ${item.watched}/${item.minutes} min`)
					await this.updateProgress(item, progress.isClaimed ? 'Награда получена' : 'Просмотр')
					if (progress.isClaimed) {
						await this.earned(item)
						continue
					}
					if (item.watched >= item.minutes) {
						this.sessions.delete(item.stream.user_id)
						this.nextPlan = 0
					}
				}
			}
			if (!this.sessions.has(item.stream.user_id)) continue
			const parallel = this.sessions.size > 1
			if (parallel && isPriority(item, this.twitch.config.scheduler?.priorityReward) && Date.now() - session.lastProgress >= 180000) {
				this.parallelBlockedUntil = Date.now() + 1800000
				this.verifiedSlots = 1
				session.lastProgress = Date.now()
				for (const id of this.sessions.keys()) if (id !== item.stream.user_id) this.sessions.delete(id)
				this.nextPlan = 0
				await this.notify('parallel-blocked', 'Priority progress stalled; secondary stream suspended for 30 min')
			}
			if (Date.now() - session.lastProgress >= 300000) {
				this.cooldown.set(item.stream.user_id, Date.now() + 300000)
				this.sessions.delete(item.stream.user_id)
				this.nextPlan = 0
				if (parallel) {
					this.parallelBlockedUntil = Date.now() + 1800000
					this.verifiedSlots = 1
				}
				await this.updateProgress(item, 'Нет прогресса 5 минут — перепланирование')
				continue
			}
			try {
				await this.watchSession(session)
			} catch (error) {
				if (error instanceof Error && (error.fatal || this.twitch.signal?.aborted)) throw error
				this.cooldown.set(item.stream.user_id, Date.now() + 180000)
				this.sessions.delete(item.stream.user_id)
				this.nextPlan = 0
				this.twitch.log.warn('Playback unavailable | ' + item.stream.user_login)
			}
		}
		const parallelStart = Math.max(...[...this.sessions.values()].map(session => session.startedAt))
		if (this.sessions.size === 2 && [...this.sessions.values()].every(session => session.advancedAt > parallelStart)) this.verifiedSlots = 2
		await this.persist()
		return 20000
	}
}
