import { test, expect } from 'bun:test'
import { fairChoice, eligibleDrop, rewardRows, progressMessage, mergeCandidates } from './follow-drops.ts'
import { FollowDrops } from './follow-drops.ts'
import { validateConfig } from './config.ts'
import { Notifications } from './notifications.ts'
import { Twitch } from './twitch.ts'
import type { Drop } from './types.ts'
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('suspending for streaks releases playback and resumes the saved badge progress', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'streak-pause-')),
		path = join(directory, 'config.json')
	const config = {
		id: '1',
		login: 'owner',
		client_id: 'client',
		token: 'token',
		scheduler: { maxConcurrentStreams: 1 as const, historyEnabled: false }
	}
	await Bun.write(path, JSON.stringify(config))
	try {
		const twitch = new Twitch(config)
		twitch.followedLive = async () => [{ id: '2', login: 'channel' }]
		twitch.streams = async () => [{ id: 'live', user_id: '2', user_login: 'channel', game_id: 'g', game_name: 'game', type: 'live' }]
		twitch.inventory = async () => []
		twitch.badges = async () => new Set()
		twitch.channelCampaigns = async () => [
			{
				id: 'campaign',
				rewardGroups: [
					{
						id: 'group',
						rewards: [{ dropDetail: { badge: { setID: 'badge', version: '1' } } }],
						progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 } },
						self: { status: 'IN_PROGRESS', currentMinutesWatched: 12, grantCount: 0, hasPreconditionsMet: true }
					}
				]
			}
		]
		let watched = 0
		twitch.watch = async () => {
			watched++
		}
		const farmer = new FollowDrops(twitch, undefined, path)
		await farmer.step()
		expect(watched).toBe(1)
		await farmer.suspend()
		const paused = JSON.parse(await readFile(path + '.status.json', 'utf8'))
		expect(paused.activeChannels).toEqual([])
		expect(paused.rewards[0].watchedMinutes).toBe(12)
		await farmer.step()
		expect(watched).toBe(2)
		expect(JSON.parse(await readFile(path + '.status.json', 'utf8')).activeChannels).toEqual(['channel'])
	} finally {
		const { rm } = await import('node:fs/promises')
		await rm(directory, { recursive: true, force: true })
	}
})

test('round robin treats every channel equally and wraps', () => {
	const items = ['pwgood', 'aaa', 'zzz'].map(user_login => ({ stream: { user_login } }))
	expect(fairChoice(items, '')?.stream.user_login).toBe('aaa')
	expect(fairChoice(items, 'aaa')?.stream.user_login).toBe('pwgood')
	expect(fairChoice(items, 'zzz')?.stream.user_login).toBe('aaa')
	expect(fairChoice([], '')).toBeUndefined()
})
test('skips expired, paid, claimed and locked drops', () => {
	const drop: Drop = { id: 'd', requiredMinutesWatched: 10, startAt: new Date(0).toISOString(), endAt: new Date(2000).toISOString() }
	expect(eligibleDrop({ id: 'c' }, drop, 1000)).toBe(true)
	for (const change of [
		{ requiredSubs: 1 },
		{ self: { currentMinutesWatched: 0, isClaimed: true } },
		{ self: { currentMinutesWatched: 0, hasPreconditionsMet: false } },
		{ endAt: new Date(500).toISOString() }
	])
		expect(eligibleDrop({ id: 'c' }, { ...drop, ...change }, 1000)).toBe(false)
})
test('notifications are disabled without settings', async () => {
	const n = new Notifications(undefined, (() => {
		throw new Error('must not send')
	}) as unknown as typeof fetch)
	expect(await n.send('test', 'hello')).toEqual([])
})
test('Telegram, Discord and webhook payloads, duplicate suppression', async () => {
	const bodies: Record<string, unknown>[] = []
	const request = (async (url: string | URL | Request, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)))
		return new Response(String(url).includes('telegram') ? '{"ok":true}' : '{}')
	}) as unknown as typeof fetch
	const n = new Notifications(
		{
			telegram: { token: '123:test', chatId: '42' },
			discord: { webhook: 'https://discord.com/api/webhooks/1/test' },
			webhook: { url: 'https://example.com/hook' }
		},
		request
	)
	expect(await n.send('test', '@everyone hello')).toEqual([])
	expect(bodies).toHaveLength(3)
	expect(bodies[0]?.chat_id).toBe('42')
	expect(bodies[1]?.allowed_mentions).toEqual({ parse: [] })
	expect(bodies[2]?.event).toBe('test')
	await n.send('test', '@everyone hello')
	expect(bodies).toHaveLength(3)
})
test('delivery errors do not leak webhook credentials and remain retryable', async () => {
	let calls = 0
	const n = new Notifications({ webhook: { url: 'https://secret.example/token' } }, (async () => {
		calls++
		throw new Error('secret')
	}) as unknown as typeof fetch)
	expect(await n.send('test', 'hello')).toEqual(['webhook: delivery failed'])
	await n.send('test', 'hello')
	expect(calls).toBe(2)
})
test('follows pagination includes live channels from later pages', async () => {
	const twitch = new Twitch({ id: '1', login: 'test', client_id: 'client', token: 'token' })
	let calls = 0
	twitch.gql = (async () => ({
		user: {
			follows: {
				edges: [{ cursor: String(++calls), node: { id: String(calls), login: 'ch' + calls, stream: calls === 2 ? { id: 'live' } : null } }],
				pageInfo: { hasNextPage: calls < 2 }
			}
		}
	})) as typeof twitch.gql
	expect(await twitch.followedLive()).toEqual([{ id: '2', login: 'ch2' }])
})
test('all followed channels include offline entries across pages', async () => {
	const twitch = new Twitch({ id: '1', login: 'test', client_id: 'client', token: 'token' })
	let calls = 0
	twitch.gql = (async () => ({
		user: {
			follows: {
				edges: [{ cursor: String(++calls), node: { id: String(calls), login: 'ch' + calls, stream: calls === 2 ? { id: 'live' } : null } }],
				pageInfo: { hasNextPage: calls < 2 }
			}
		}
	})) as typeof twitch.gql
	expect(await twitch.followedChannels()).toEqual([
		{ id: '1', login: 'ch1', live: false },
		{ id: '2', login: 'ch2', live: true }
	])
})
test('legacy config remains valid when follow mode is disabled', () => {
	expect(validateConfig({ id: '1', login: 'TEST', client_id: 'client', token: 'oauth:secret' })).toMatchObject({
		login: 'test',
		token: 'secret',
		followDrops: false
	})
	expect(() => validateConfig({ followDrops: 'true' })).toThrow()
})
test('HTTP and Telegram API failures are reported', async () => {
	const settings = { telegram: { token: '1:token', chatId: '1' } }
	expect(
		await new Notifications(settings, (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch).send('test', 'hi')
	).toEqual(['telegram: HTTP 429'])
	expect(await new Notifications(settings, (async () => new Response('{"ok":false}')) as unknown as typeof fetch).send('test', 'hi')).toEqual([
		'telegram: rejected'
	])
})
test('ordinary game Drops never start playback or claims', async () => {
	const twitch = new Twitch({ id: '1', login: 'test', client_id: 'client', token: 'token' })
	const now = Date.now()
	const drop = {
		id: 'd',
		requiredMinutesWatched: 10,
		startAt: new Date(now - 1000).toISOString(),
		endAt: new Date(now + 3600000).toISOString(),
		benefitEdges: [{ benefit: { name: 'Test reward' } }],
		self: { currentMinutesWatched: 10, dropInstanceID: 'instance', isClaimed: false }
	}
	const campaign = { id: 'c', timeBasedDrops: [drop] }
	twitch.followedLive = async () => [{ id: '2', login: 'channel' }]
	twitch.inventory = async () => [campaign]
	twitch.badges = async () => new Set()
	twitch.streams = async () => [{ id: 'live', user_id: '2', user_login: 'channel', game_id: 'g', game_name: 'game', type: 'live' }]
	twitch.gql = (async () => ({ channel: { viewerDropCampaigns: [campaign] } })) as typeof twitch.gql
	twitch.channelCampaigns = async () => []
	let claims = 0
	twitch.claimDrop = async instance => {
		expect(instance).toBe('instance')
		claims++
	}
	twitch.watch = async () => {
		throw new Error('already ready to claim')
	}
	const collector = new FollowDrops(twitch)
	expect(await collector.step()).toBe(60_000)
	expect(claims).toBe(0)
})
test('ineligible reward groups do not start viewing', async () => {
	const twitch = new Twitch({ id: '1', login: 'test', client_id: 'client', token: 'token' })
	twitch.followedLive = async () => [{ id: '2', login: 'channel' }]
	twitch.inventory = async () => []
	twitch.badges = async () => new Set()
	twitch.streams = async () => [{ id: 'live', user_id: '2', user_login: 'channel', game_id: 'g', game_name: 'game', type: 'live' }]
	twitch.gql = (async () => ({
		channel: {
			viewerDropCampaigns: [
				{
					id: 'c',
					timeBasedDrops: [
						{
							id: 'unavailable',
							requiredMinutesWatched: 60,
							startAt: new Date(0).toISOString(),
							endAt: new Date(Date.now() + 3600000).toISOString()
						}
					]
				}
			]
		}
	})) as typeof twitch.gql
	twitch.channelCampaigns = async () => [
		{
			id: 'c',
			rewardGroups: [{ id: 'unavailable', progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 } }, self: null }]
		}
	]
	twitch.watch = async () => {
		throw new Error('must not watch')
	}
	expect(await new FollowDrops(twitch).step()).toBe(60_000)
})
test('channel progress is read when the group is absent from inventory', async () => {
	const twitch = new Twitch({ id: '1', login: 'test', client_id: 'client', token: 'token' })
	twitch.followedLive = async () => [{ id: '2', login: 'channel' }]
	twitch.inventory = async () => []
	twitch.badges = async () => new Set()
	twitch.streams = async () => [{ id: 'live', user_id: '2', user_login: 'channel', game_id: 'g', game_name: 'game', type: 'live' }]
	twitch.gql = (async () => ({ channel: { viewerDropCampaigns: [] } })) as typeof twitch.gql
	let reads = 0,
		watches = 0
	twitch.channelCampaigns = async () => {
		reads++
		return [
			{
				id: 'c',
				rewardGroups: [
					{
						id: 'group',
						rewards: [{ distributionType: 'BADGE', dropDetail: { badge: { setID: 'creator', version: '1' } } }],
						progressCriteria: { requirementType: 'WATCH', requirements: { minutesWatched: 60 } },
						self: { status: 'IN_PROGRESS', currentMinutesWatched: reads, grantCount: 0, hasPreconditionsMet: true }
					}
				]
			}
		]
	}
	twitch.watch = async () => {
		watches++
	}
	expect(await new FollowDrops(twitch).step()).toBe(20_000)
	expect(reads).toBe(2)
	expect(watches).toBe(1)
})
test('reward listing groups duplicate channel/reward pairs and preserves UTC dates', () => {
	const item = {
		stream: { id: 's', user_id: '1', user_login: 'aaa', game_id: 'g', game_name: 'game', type: 'live', drop: { id: 'd', campaignId: 'c' } },
		title: 'PepeLand 11 START',
		minutes: 660,
		watched: 60,
		start: 1000,
		end: 2000,
		claimed: false
	}
	const rows = rewardRows([item, { ...item, stream: { ...item.stream, user_id: '2', user_login: 'bbb' } }])
	expect(rows).toHaveLength(1)
	expect(rows[0]?.channels).toEqual(['aaa', 'bbb'])
	expect(rows[0]?.openedUTC).toBe(new Date(1000).toISOString())
	expect(rows[0]?.closesUTC).toBe(new Date(2000).toISOString())
	expect(progressMessage(item)).toContain('60/660')
	expect(progressMessage({ ...item, start: NaN, end: Infinity })).toContain('Twitch не указал')
})
test('the two Twitch representations of a reward use one row and authoritative progress', () => {
	const item = {
		stream: { id: 's', user_id: '1', user_login: 'pwgood', game_id: 'g', game_name: 'game', type: 'live', drop: { id: 'd', campaignId: 'c' } },
		title: 'PepeLand 11 START',
		minutes: 660,
		watched: 0,
		start: 1000,
		end: 2000,
		claimed: false
	}
	const group = {
		...item,
		stream: { ...item.stream, drop: { ...item.stream.drop, kind: 'reward-group' as const } },
		title: 'internal-badge-id',
		watched: 426
	}
	for (const items of [
		[item, group],
		[group, item]
	]) {
		const merged = mergeCandidates(items)
		expect(merged).toHaveLength(1)
		expect(merged[0]?.title).toBe('PepeLand 11 START')
		expect(merged[0]?.watched).toBe(426)
		expect(merged[0]?.stream.drop.kind).toBe('reward-group')
		expect(rewardRows(items)).toHaveLength(1)
	}
	expect(mergeCandidates([item, { ...group, stream: { ...group.stream, drop: { ...group.stream.drop, campaignId: 'different' } } }])).toHaveLength(
		2
	)
})
test('Telegram sends once, then edits the same message and resumes after restart', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'farmer-telegram-'))
	const path = join(directory, 'notification.state.json')
	const calls: { url: string; body: Record<string, unknown> }[] = []
	const request = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
		return new Response('{"ok":true,"result":{"message_id":123}}')
	}) as unknown as typeof fetch
	try {
		const config = { telegram: { token: '1:secret', chatId: '42' } }
		const n = new Notifications(config, request, path)
		expect(await n.send('progress', '1/10')).toEqual([])
		expect(await n.send('progress', '2/10')).toEqual([])
		await n.send('progress', '2/10')
		expect(calls).toHaveLength(2)
		expect(calls[0]?.url).toEndWith('/sendMessage')
		expect(calls[1]?.url).toEndWith('/editMessageText')
		expect(calls[1]?.body.message_id).toBe(123)
		expect(await readFile(path, 'utf8')).not.toContain('secret')
		await new Notifications(config, request, path).send('progress', '3/10')
		expect(calls[2]?.url).toEndWith('/editMessageText')
		expect(calls[2]?.body.message_id).toBe(123)
	} finally {
		await unlink(path)
		await rmdir(directory)
	}
})
test('Telegram recreates a deleted progress message but not on permission errors', async () => {
	const calls: string[] = []
	let failure = 'Bad Request: message to edit not found'
	const request = (async (url: string | URL | Request) => {
		calls.push(String(url))
		return String(url).endsWith('/sendMessage')
			? new Response('{"ok":true,"result":{"message_id":123}}')
			: new Response(JSON.stringify({ ok: false, description: failure }), { status: 400 })
	}) as unknown as typeof fetch
	const n = new Notifications({ telegram: { token: '1:token', chatId: '1' } }, request)
	await n.send('progress', 'first')
	expect(await n.send('progress', 'second')).toEqual([])
	expect(calls).toHaveLength(3)
	failure = 'Forbidden'
	expect(await n.send('progress', 'third')).toHaveLength(1)
	expect(calls).toHaveLength(4)
})
test('Telegram accepts unchanged text errors and respects retry_after', async () => {
	let calls = 0
	let response = new Response('{"ok":true,"result":{"message_id":123}}')
	const n = new Notifications({ telegram: { token: '1:token', chatId: '1' } }, (async () => {
		calls++
		return response.clone()
	}) as unknown as typeof fetch)
	await n.send('progress', 'first')
	response = new Response('{"ok":false,"description":"Bad Request: message is not modified"}', { status: 400 })
	expect(await n.send('progress', 'second')).toEqual([])
	response = new Response('{"ok":false,"parameters":{"retry_after":60}}', { status: 429 })
	expect(await n.send('progress', 'third')).toHaveLength(1)
	await n.send('progress', 'fourth')
	expect(calls).toBe(3)
})
