import { readFile, writeFile, rename, stat, chown } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readConfig, validateConfig } from './config.ts'

export const controlKeyboard = {
	inline_keyboard: [
		[
			{ text: 'Каналы', callback_data: 'bf:channels' },
			{ text: 'Бейджи', callback_data: 'bf:badges:0' }
		],
		[
			{ text: '+ Канал', callback_data: 'bf:add' },
			{ text: '− Канал', callback_data: 'bf:remove' }
		],
		[
			{ text: 'Приоритет бейджа', callback_data: 'bf:badge' },
			{ text: 'Приоритет канала', callback_data: 'bf:channel' }
		]
	]
}
type Account = { path: string; chatId: string }
type Update = {
	update_id: number
	message?: { text?: string; chat: { id: number; type?: string }; from?: { id: number } }
	callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type?: string } } }
}
type State = { offset: number; pending: Record<string, { command: string; at: number }>; menus: Record<string, number> }
const digest = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 20)
export function channelLogin(input: string) {
	const value = input
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\/(?:www\.)?twitch\.tv\//, '')
		.replace(/^@/, '')
		.replace(/\/$/, '')
	if (!/^[a-z0-9_]{1,25}$/.test(value)) throw new Error('Укажите логин канала или ссылку Twitch.')
	return value
}
async function atomic(path: string, value: unknown) {
	const tmp = path + '.' + process.pid + '.tmp'
	await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
	if (process.platform !== 'win32') {
		const owner = await stat(path).catch(() => undefined)
		if (owner) await chown(tmp, owner.uid, owner.gid)
	}
	await rename(tmp, path)
}
export class TelegramControl {
	private state: State = { offset: 0, pending: {}, menus: {} }
	private loaded = false
	private nextPoll = 0
	constructor(
		private token: string,
		private accounts: Account[],
		private statePath: string,
		private request: typeof fetch = fetch,
		private changed: (path: string, command: string, value: string) => Promise<void> = async () => {}
	) {
		if (accounts.some(a => !/^[1-9]\d*$/.test(a.chatId)) || new Set(accounts.map(a => a.chatId)).size !== accounts.length)
			throw new Error('Telegram controls require distinct private chats')
	}
	private async api(method: string, payload: unknown): Promise<any> {
		try {
			const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(12_000),
				redirect: 'error'
			})
			const body = (await response.json()) as any
			if (!response.ok || !body.ok) {
				if (body.parameters?.retry_after) this.nextPoll = Date.now() + Number(body.parameters.retry_after) * 1000
				if (/message is not modified/i.test(body.description ?? '')) return {}
				if (/message to edit not found|message can.t be edited/i.test(body.description ?? '')) throw new Error('PANEL_DELETED')
				throw new Error()
			}
			return body.result
		} catch (error) {
			if (error instanceof Error && error.message === 'PANEL_DELETED') throw error
			throw new Error('Telegram control request failed')
		}
	}
	private async panel(account: Account, text: string, keyboard: unknown = controlKeyboard) {
		const messageId = this.state.menus[account.chatId]
		if (messageId) {
			try {
				await this.api('editMessageText', {
					chat_id: account.chatId,
					message_id: messageId,
					text: text.slice(0, 4000),
					reply_markup: keyboard
				})
				return
			} catch (error) {
				if (!(error instanceof Error) || error.message !== 'PANEL_DELETED') return
				delete this.state.menus[account.chatId]
			}
		}
		const message = await this.api('sendMessage', {
			chat_id: account.chatId,
			text: text.slice(0, 4000),
			reply_markup: keyboard,
			disable_notification: true
		})
		this.state.menus[account.chatId] = message.message_id
	}
	private async rows(account: Account): Promise<{ id: string; reward: string; channel: string }[]> {
		try {
			return JSON.parse(await readFile(account.path + '.status.json', 'utf8')).rewards ?? []
		} catch {
			return []
		}
	}
	async handle(update: Update) {
		const callback = update.callback_query,
			message = callback?.message ?? update.message
		const sender = callback?.from ?? update.message?.from
		const account = this.accounts.find(
			a => a.chatId === String(message?.chat.id) && a.chatId === String(sender?.id) && message?.chat.type === 'private'
		)
		if (!account) return
		if (callback) await this.api('answerCallbackQuery', { callback_query_id: callback.id })
		const config = validateConfig(await readConfig(account.path))
		let text = update.message?.text?.trim() ?? ''
		if (callback?.data?.startsWith('bf:')) {
			const action = callback.data.slice(3)
			if (action.startsWith('pick:')) {
				const row = (await this.rows(account)).find(r => digest(r.id) === action.slice(5))
				if (!row) return this.panel(account, 'Список изменился. Откройте «Бейджи» снова.')
				text = '/priority_badge ' + row.id
			} else if (action.startsWith('badges:')) {
				const rows = [...new Map((await this.rows(account)).map(r => [r.id, r])).values()]
				const page = Math.max(0, Number(action.split(':')[1]) || 0),
					start = page * 8
				return this.panel(account, 'Выберите приоритетный бейдж:', {
					inline_keyboard: [
						...rows
							.slice(start, start + 8)
							.map(r => [{ text: r.reward.slice(0, 45) + ' · ' + r.channel, callback_data: 'bf:pick:' + digest(r.id) }]),
						...(start ? [[{ text: '←', callback_data: 'bf:badges:' + (page - 1) }]] : []),
						...(rows.length > start + 8 ? [[{ text: '→', callback_data: 'bf:badges:' + (page + 1) }]] : []),
						[{ text: 'Снять приоритет', callback_data: 'bf:clearbadge' }]
					]
				})
			} else if (action === 'clearbadge') text = '/priority_badge none'
			else if (action === 'channels') text = '/channels'
			else if (['add', 'remove', 'badge', 'channel'].includes(action)) {
				const command = ({ add: 'add', remove: 'remove', badge: 'priority_badge', channel: 'priority_channel' } as Record<string, string>)[
					action
				]!
				this.state.pending[account.chatId] = { command, at: Date.now() }
				return this.panel(
					account,
					action === 'badge'
						? 'Отправьте название или ID бейджа; none — снять приоритет. Или выберите «Бейджи».'
						: 'Отправьте логин канала; для снятия приоритета — none. /cancel — отмена.'
				)
			} else return
		}
		if (!text.startsWith('/')) {
			const pending = this.state.pending[account.chatId]
			if (!pending || Date.now() - pending.at > 600000) return
			text = '/' + pending.command + ' ' + text
		}
		const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text)
		if (!match) return
		const command = match[1]!,
			value = (match[2] ?? '').trim()
		if (['start', 'menu', 'help', 'cancel'].includes(command)) {
			delete this.state.pending[account.chatId]
			return this.panel(
				account,
				'Управление Twitch Badge Farmer\n/add канал\n/remove канал\n/priority_badge название или ID\n/priority_channel канал\n/channels\nnone — снять приоритет'
			)
		}
		if (command === 'channels')
			return this.panel(
				account,
				`@${config.login}\nПриоритетный бейдж: ${config.scheduler?.priorityReward ?? '—'}\nПриоритетный канал: ${config.scheduler?.priorityChannel ?? '—'}\n\nФолловы: автоматически\nДобавлены: ${config.channels?.added.map(c => c.login).join(', ') || '—'}\nИсключены: ${config.channels?.excluded.join(', ') || '—'}`
			)
		if (!['add', 'remove', 'priority_badge', 'priority_channel'].includes(command)) return
		try {
			if (!value || value.length > 200) throw new Error('Укажите значение (до 200 символов).')
			config.channels ??= { added: [], excluded: [] }
			config.scheduler ??= {}
			let normalized = value
			if (command === 'priority_badge') {
				if (value === 'none') delete config.scheduler.priorityReward
				else config.scheduler.priorityReward = value
			} else if (command === 'priority_channel' && value === 'none') delete config.scheduler.priorityChannel
			else {
				normalized = channelLogin(value)
				if (command === 'remove') {
					config.channels.added = config.channels.added.filter(c => c.login !== normalized)
					config.channels.excluded = [...new Set([...config.channels.excluded, normalized])]
				} else {
					const response = await this.request('https://api.twitch.tv/helix/users?login=' + normalized, {
						headers: { 'Client-ID': config.client_id, Authorization: 'Bearer ' + config.token },
						signal: AbortSignal.timeout(10_000)
					})
					const data = (await response.json()) as { data?: { id: string; login: string }[] }
					if (!response.ok || !data.data?.[0]) throw new Error('Канал не найден или Twitch временно недоступен.')
					if (command === 'priority_channel') config.scheduler.priorityChannel = normalized
					else {
						config.channels.added = [
							...config.channels.added.filter(c => c.login !== normalized),
							{ id: data.data[0].id, login: normalized }
						]
						config.channels.excluded = config.channels.excluded.filter(c => c !== normalized)
					}
				}
			}
			// Preserve unknown configuration keys, including local integration settings.
			const raw = (await readConfig(account.path)) as Record<string, unknown>
			await atomic(account.path, { ...raw, channels: config.channels, scheduler: config.scheduler })
			await this.changed(account.path, command, normalized)
			delete this.state.pending[account.chatId]
			await this.panel(account, `Сохранено · @${config.login}\n${command}: ${normalized}`)
		} catch (error) {
			await this.panel(
				account,
				error instanceof Error && !/token|oauth|request failed/i.test(error.message)
					? error.message
					: 'Не удалось применить изменение. Повторите команду.'
			)
		}
	}
	async poll() {
		if (Date.now() < this.nextPoll) return
		this.nextPoll = Date.now() + 3000
		if (!this.loaded) {
			try {
				this.state = JSON.parse(await readFile(this.statePath, 'utf8'))
			} catch (error) {
				if (!(error instanceof Error) || error.code !== 'ENOENT') throw new Error('Telegram control state unreadable')
			}
			this.loaded = true
		}
		try {
			const updates = (await this.api('getUpdates', {
				offset: this.state.offset,
				timeout: 0,
				allowed_updates: ['message', 'callback_query']
			})) as Update[]
			for (const update of updates) {
				await this.handle(update)
				this.state.offset = update.update_id + 1
				await atomic(this.statePath, this.state)
			}
		} catch {
			this.nextPoll = Math.max(this.nextPoll, Date.now() + 15000)
		}
	}
}
