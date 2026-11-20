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
	config.followDrops = record.followDrops === true
	if (record.notifications !== undefined) {
		const n = record.notifications as NonNullable<Config['notifications']>
		if (!n || typeof n !== 'object') throw new Error('Config | Invalid notifications')
		if (n.telegram && (!/^\d+:[A-Za-z0-9_-]+$/.test(n.telegram.token) || !/^-?\d+$/.test(n.telegram.chatId)))
			throw new Error('Config | Invalid Telegram settings')
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
