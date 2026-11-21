import { expect, test } from 'bun:test'
import { parseHistory, Histories, type StreamHistory } from './history.ts'
import { planSchedule, isPriority } from './scheduler.ts'
import { FollowDrops, type Candidate } from './follow-drops.ts'
import { Twitch } from './twitch.ts'

const now = Date.now()
const stats: StreamHistory = {
	averageMinutes: 300,
	streamsPerDay: 1,
	samples: 25,
	source: 'lurkology',
	sourceUrl: 'https://lurkology.com/test/streams',
	fetchedAt: now
}
function reward(login: string, remaining: number, deadlineMinutes: number, title = login): Candidate {
	return {
		stream: {
			id: login,
			user_id: login,
			user_login: login,
			game_id: 'g',
			game_name: 'game',
			type: 'live',
			drop: { campaignId: login, id: login }
		},
		title,
		minutes: remaining,
		watched: 0,
		start: now - 1000,
		end: now + deadlineMinutes * 60000,
		live: true,
		claimed: false
	}
}

test('Lurkology aggregate converts 106 hours / 25 streams into 254.4 minutes', () => {
	const value = parseHistory('<p>Over the last <b>30 days</b> PWGood streamed 106h across 25 streams, averaging 2,259 viewers.</p>', 'pwgood', now)
	expect(value?.averageMinutes).toBeCloseTo(254.4)
	expect(value?.streamsPerDay).toBeCloseTo(25 / 30)
	expect(parseHistory('No recent streams', 'test')).toBeNull()
	expect(parseHistory('last 30 days test streamed 106h across 0 streams', 'test')).toBeNull()
})
test('history failures use an explicitly unknown fallback; successful fetches are cached', async () => {
	let calls = 0
	const history = new Histories(undefined, (async () => {
		calls++
		return new Response('Over the last 30 days test streamed 100h across 20 streams')
	}) as unknown as typeof fetch)
	await history.refresh(['test'])
	await history.refresh(['test'])
	expect(calls).toBe(1)
	expect(history.get('test').averageMinutes).toBe(300)
	expect(history.get('missing').source).toBe('fallback')
	const unavailable = new Histories(undefined, (async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch)
	await unavailable.refresh(['test'])
	expect(unavailable.get('test').source).toBe('fallback')
})
test('pinned priority reserves a slot even when another reward expires sooner', () => {
	const priority = reward('pwgood', 234, 2880, 'PepeLand 11 START')
	const result = planSchedule(
		[reward('other', 10, 20), priority],
		() => stats,
		{ priorityReward: 'PepeLand 11 START', maxConcurrentStreams: 1 },
		now
	)
	expect(result.selected[0]?.stream.user_login).toBe('pwgood')
	expect(isPriority(priority, priority.stream.drop.id)).toBe(true)
	expect(result.rows[0]?.priority).toBe(true)
})
test('scarce future airtime changes the viewing order', () => {
	const result = planSchedule(
		[reward('ample', 300, 2880), reward('scarce', 300, 2880)],
		login => ({ ...stats, averageMinutes: login === 'ample' ? 600 : 180, streamsPerDay: 0.5 }),
		{ maxConcurrentStreams: 1 },
		now
	)
	expect(result.selected[0]?.stream.user_login).toBe('scarce')
})
test('two slots use distinct channels and campaigns', () => {
	const first = reward('a', 20, 120),
		duplicateCampaign = reward('b', 20, 120),
		third = reward('c', 20, 120)
	duplicateCampaign.stream.drop.campaignId = 'a'
	const plan = planSchedule([first, duplicateCampaign, third], () => stats, { maxConcurrentStreams: 2 }, now)
	expect(plan.selected.map(item => item.stream.user_login)).toEqual(['a', 'c'])
	expect(plan.assumedSlots).toBe(1)
	expect(plan.warnings.some(value => value.includes('experimental'))).toBe(true)
})
test('shared workload warning exposes conflicting deadlines instead of promising completion', () => {
	const items = [reward('a', 90, 120), reward('b', 90, 120)]
	expect(planSchedule(items, () => stats, { maxConcurrentStreams: 2 }, now, 1).warnings.some(value => value.includes('Insufficient'))).toBe(true)
	expect(planSchedule(items, () => stats, { maxConcurrentStreams: 2 }, now, 2).warnings.some(value => value.includes('Insufficient'))).toBe(false)
})
test('offline and expired rewards are reported without allocating playback', () => {
	const offline = { ...reward('offline', 20, 2880), live: false }
	const plan = planSchedule([offline, reward('expired', 10, -1)], () => stats, { maxConcurrentStreams: 2 }, now)
	expect(plan.selected).toHaveLength(0)
	expect(plan.rows.find(row => row.channel === 'expired')?.risk).toBe('expired')
})
test('impossible deadlines do not starve achievable rewards', () => {
	const plan = planSchedule([reward('impossible', 900, 10), reward('possible', 10, 120)], () => stats, { maxConcurrentStreams: 1 }, now)
	expect(plan.selected[0]?.stream.user_login).toBe('possible')
	expect(plan.rows.find(row => row.channel === 'impossible')?.risk).toBe('unlikely')
})
test('two playback sessions keep independent caches and require confirmed parallel progress', async () => {
	const original = Date.now
	let clock = now
	const watched: Record<string, number> = { a: 0, b: 0 }
	Date.now = () => clock
	try {
		const twitch = new Twitch({
			id: '1',
			login: 'test',
			client_id: 'client',
			token: 'token',
			scheduler: { priorityReward: 'PepeLand 11 START', maxConcurrentStreams: 2, historyEnabled: false }
		})
		twitch.followedLive = async () => [
			{ id: 'a', login: 'a' },
			{ id: 'b', login: 'b' }
		]
		twitch.badges = async () => new Set()
		const campaign = (id: string) => ({
			id,
			name: id === 'a' ? 'PepeLand 11 START' : 'Other',
			rewardGroups: [
				{
					id,
					progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 } },
					rewards: [{ distributionType: 'BADGE', dropDetail: { badge: { setID: 'creator-' + id, version: '1' } } }],
					self: { status: 'IN_PROGRESS', currentMinutesWatched: watched[id]!, grantCount: 0, hasPreconditionsMet: true }
				}
			]
		})
		twitch.inventory = async () => [campaign('a'), campaign('b')]
		twitch.streams = async task => [
			{
				id: task.channels[0]!.id,
				user_id: task.channels[0]!.id,
				user_login: task.channels[0]!.login,
				game_id: 'g',
				game_name: 'game',
				type: 'live'
			}
		]
		twitch.gql = (async (_operation: string, variables: { channelID: string }) => ({
			channel: { viewerDropCampaigns: [campaign(variables.channelID)] }
		})) as typeof twitch.gql
		twitch.channelCampaigns = async id => [campaign(id)]
		const playback: (string | undefined)[] = []
		twitch.watch = async stream => {
			playback.push(twitch.playback?.id)
			twitch.playback = { id: stream.id, url: 'https://example.com/' + stream.id }
		}
		const collector = new FollowDrops(twitch)
		await collector.step()
		expect(playback).toEqual([undefined, undefined])
		expect(collector.plan().assumedSlots).toBe(1)
		clock += 61000
		watched.a = 1
		watched.b = 1
		await collector.step()
		expect(playback.slice(-2)).toEqual(['a', 'b'])
		expect(collector.plan().assumedSlots).toBe(2)
		clock += 181000
		watched.b = 2
		await collector.step()
		expect(collector.plan().assumedSlots).toBe(1)
		expect(collector.plan().selected.map(item => item.stream.user_login)).toEqual(['a'])
	} finally {
		Date.now = original
	}
})

test('completed watch requirement never consumes a slot while claim is pending', () => {
	const done = reward('done', 180, 60)
	done.watched = 180
	const pending = reward('pending', 30, 60)
	const plan = planSchedule([done, pending], () => stats, { maxConcurrentStreams: 1, priorityReward: 'done' }, now)
	expect(plan.selected.map(item => item.title)).toEqual(['pending'])
	expect(plan.rows.find(row => row.channel === 'done')?.remainingMinutes).toBe(0)
})
