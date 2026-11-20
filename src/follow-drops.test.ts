import { test, expect } from 'bun:test'
import { fairChoice, eligibleDrop } from './follow-drops.ts'
import { FollowDrops } from './follow-drops.ts'
import { validateConfig } from './config.ts'
import { Notifications } from './notifications.ts'
import { Twitch } from './twitch.ts'
import type { Drop } from './types.ts'

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
test('follow collector watches, claims with instance ID and waits for confirmation', async () => {
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
	expect(await collector.step()).toBe(20_000)
	expect(claims).toBe(1)
})
test('ineligible reward groups do not start viewing', async () => {
	const twitch = new Twitch({ id: '1', login: 'test', client_id: 'client', token: 'token' })
	twitch.followedLive = async () => [{ id: '2', login: 'channel' }]
	twitch.inventory = async () => []
	twitch.badges = async () => new Set()
	twitch.streams = async () => [{ id: 'live', user_id: '2', user_login: 'channel', game_id: 'g', game_name: 'game', type: 'live' }]
	twitch.gql = (async () => ({ channel: { viewerDropCampaigns: [] } })) as typeof twitch.gql
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
