import type { Config } from './types.ts'
import { readFile } from 'node:fs/promises'

export async function readConfig(path: string | URL): Promise<unknown> {
	let text

	try {
		text = await readFile(path, 'utf8')
	} catch (cause) {
		if (!(cause instanceof Error)) throw cause

		const error = new Error(
			cause.code === 'ENOENT' ? 'Config | Not found | Run with --gen-token' : 'Config | Could not read (' + cause.code + ')'
		)

		error.code = cause.code

		throw error
	}

	try {
		return JSON.parse(text.replace(/^\uFEFF/, ''))
	} catch {
		throw new Error('Config | Invalid JSON')
	}
}

export function validateConfig(input: unknown): Config {
	const fields = ['login', 'client_id', 'token'] as const
	const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
	const config: Config = { id: String(record.id || '').trim(), login: '', client_id: '', token: '' }

	for (const field of fields) {
		config[field] = typeof record[field] === 'string' ? record[field].trim() : ''
	}

	config.login = config.login.toLowerCase()
	config.token = config.token.replace(/^oauth:/i, '').trim()
	if (record.followDrops !== undefined && typeof record.followDrops !== 'boolean') throw new Error('Config | followDrops must be boolean')
	config.followDrops = record.followDrops !== false
	if (record.channels !== undefined) {
		const value = record.channels as Config['channels']
		if (
			!value ||
			!Array.isArray(value.added) ||
			!Array.isArray(value.excluded) ||
			value.added.some(c => !c || !/^\d+$/.test(c.id) || !/^[a-z0-9_]{1,25}$/.test(c.login)) ||
			value.excluded.some(c => typeof c !== 'string' || !/^[a-z0-9_]{1,25}$/.test(c))
		)
			throw new Error('Config | Invalid channels')
		config.channels = value
	}
	if (record.scheduler !== undefined) {
		if (!record.scheduler || typeof record.scheduler !== 'object') throw new Error('Config | Invalid scheduler')
		const scheduler = record.scheduler as Record<string, unknown>
		if (scheduler.priorityReward !== undefined && (typeof scheduler.priorityReward !== 'string' || !scheduler.priorityReward.trim()))
			throw new Error('Config | priorityReward must be a nonempty name or reward ID')
		if (scheduler.maxConcurrentStreams !== undefined && scheduler.maxConcurrentStreams !== 1 && scheduler.maxConcurrentStreams !== 2)
			throw new Error('Config | maxConcurrentStreams must be 1 or 2')
		if (scheduler.historyEnabled !== undefined && typeof scheduler.historyEnabled !== 'boolean')
			throw new Error('Config | historyEnabled must be boolean')
		config.scheduler = { maxConcurrentStreams: scheduler.maxConcurrentStreams === 1 ? 1 : 2, historyEnabled: scheduler.historyEnabled !== false }
		if (typeof scheduler.priorityReward === 'string') config.scheduler.priorityReward = scheduler.priorityReward.trim()
		if (scheduler.priorityChannel !== undefined) {
			if (typeof scheduler.priorityChannel !== 'string' || !/^[a-z0-9_]{1,25}$/.test(scheduler.priorityChannel))
				throw new Error('Config | Invalid priorityChannel')
			config.scheduler.priorityChannel = scheduler.priorityChannel
		}
	}
	if (record.notifications !== undefined) {
		const n = record.notifications as NonNullable<Config['notifications']>
		if (!n || typeof n !== 'object') throw new Error('Config | Invalid notifications')
		if (n.telegram && (!/^\d+:[A-Za-z0-9_-]+$/.test(n.telegram.token) || !/^-?\d+$/.test(n.telegram.chatId)))
			throw new Error('Config | Invalid Telegram settings')
		if (n.telegram?.controls !== undefined && typeof n.telegram.controls !== 'boolean') throw new Error('Config | Invalid Telegram controls')
		if (n.telegram?.controls && !/^[1-9]\d*$/.test(n.telegram.chatId)) throw new Error('Config | Telegram controls require a private chat')
		try {
			for (const destination of [n.discord && n.discord.webhook, n.webhook && n.webhook.url]) {
				if (destination === undefined) continue
				const parsed = new URL(destination)
				if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error()
			}
			if (n.webhook && !n.webhook.url) throw new Error()
		} catch {
			throw new Error('Config | Notification URLs must be valid HTTPS URLs')
		}
		if (n.discord && !/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(n.discord.webhook))
			throw new Error('Config | Invalid Discord webhook')
		config.notifications = n
	}

	if (!config.id || fields.some(field => !config[field]) || config.token === 'your_oauth_token') {
		throw new Error('Config | Requires id, login, client_id and token | Run with --gen-token')
	}

	return config
}
