import { expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelegramControl, channelLogin } from './telegram-control.ts'
import { validateConfig } from './config.ts'

test('Telegram controls isolate accounts, persist edits and ignore unauthorized users', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'badge-control-'))
	try {
		const a = join(dir, 'a.json'),
			b = join(dir, 'b.json')
		const base = { id: '1', login: 'owner', client_id: 'client', token: 'secret', followDrops: true, custom: { keep: true } }
		await writeFile(a, JSON.stringify(base))
		await writeFile(b, JSON.stringify({ ...base, id: '2' }))
		const calls: { url: string; body: any }[] = []
		const request = (async (url: any, options: any) => {
			const body = options?.body ? JSON.parse(options.body) : {}
			calls.push({ url: String(url), body })
			if (String(url).includes('helix/users')) return Response.json({ data: [{ id: '42', login: 'examplechannel' }] })
			return Response.json({ ok: true, result: { message_id: 101 } })
		}) as typeof fetch
		const changes: string[] = []
		const bot = new TelegramControl(
			'token',
			[
				{ path: a, chatId: '100' },
				{ path: b, chatId: '200' }
			],
			join(dir, 'state'),
			request,
			async (path, cmd) => {
				changes.push(path + cmd)
			}
		)
		const message = (text: string, chat = 100, sender = chat) => ({
			update_id: 1,
			message: { text, chat: { id: chat, type: 'private' }, from: { id: sender } }
		})
		await bot.handle(message('/remove examplechannel', 100, 999))
		expect(calls).toHaveLength(0)
		await bot.handle(message('/remove examplechannel'))
		expect(JSON.parse(await readFile(a, 'utf8')).channels.excluded).toEqual(['examplechannel'])
		expect(JSON.parse(await readFile(b, 'utf8')).channels).toBeUndefined()
		await bot.handle(message('/add https://twitch.tv/ExampleChannel'))
		let config = JSON.parse(await readFile(a, 'utf8'))
		expect(config.channels).toEqual({ added: [{ id: '42', login: 'examplechannel' }], excluded: [] })
		expect(config.custom).toEqual({ keep: true })
		await bot.handle(message('/priority_badge Example Badge'))
		await bot.handle(message('/priority_channel examplechannel'))
		config = validateConfig(JSON.parse(await readFile(a, 'utf8')))
		expect(config.scheduler).toMatchObject({ priorityReward: 'Example Badge', priorityChannel: 'examplechannel' })
		await bot.handle(message('/priority_badge none'))
		await bot.handle(message('/priority_channel none'))
		expect(JSON.parse(await readFile(a, 'utf8')).scheduler.priorityReward).toBeUndefined()
		expect(calls.filter(c => c.url.endsWith('/sendMessage'))).toHaveLength(1)
		expect(calls.filter(c => c.url.endsWith('/editMessageText')).length).toBeGreaterThan(0)
		expect(changes).toHaveLength(6)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('Telegram callback input expires and group controls are rejected', async () => {
	expect(channelLogin('@ExampleChannel')).toBe('examplechannel')
	expect(() => channelLogin('examplechannel/../../etc')).toThrow()
	expect(() =>
		validateConfig({
			id: '1',
			login: 'owner',
			client_id: 'client',
			token: 'token',
			notifications: { telegram: { token: '123:abc', chatId: '-100', controls: true } }
		})
	).toThrow('private chat')
	const dir = await mkdtemp(join(tmpdir(), 'badge-callback-'))
	try {
		const path = join(dir, 'config.json')
		await writeFile(path, JSON.stringify({ id: '1', login: 'owner', client_id: 'client', token: 'token' }))
		const calls: any[] = []
		const request = (async (url: any, options: any) => {
			calls.push({ url, body: JSON.parse(options.body) })
			return Response.json({ ok: true, result: { message_id: 4 } })
		}) as typeof fetch
		const bot = new TelegramControl('token', [{ path, chatId: '100' }], join(dir, 'state'), request)
		await bot.handle({
			update_id: 1,
			callback_query: { id: 'cb', data: 'bf:remove', from: { id: 100 }, message: { message_id: 9, chat: { id: 100, type: 'private' } } }
		})
		await bot.handle({ update_id: 2, message: { text: 'examplechannel', from: { id: 100 }, chat: { id: 100, type: 'private' } } })
		expect(JSON.parse(await readFile(path, 'utf8')).channels.excluded).toEqual(['examplechannel'])
		expect(calls[0].url).toContain('answerCallbackQuery')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
