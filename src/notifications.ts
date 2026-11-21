import type { Config } from './types.ts'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { controlKeyboard } from './telegram-control.ts'

export class Notifications {
	private sent = new Map<string, number>()
	private progressId: number | undefined
	private progressText = ''
	private loaded = false
	private retryAt = 0
	constructor(
		private config: Config['notifications'],
		private request: typeof fetch = fetch,
		private statePath?: string
	) {}
	private fingerprint() {
		return createHash('sha256').update(JSON.stringify(this.config?.telegram)).digest('hex')
	}
	private async loadProgress() {
		if (this.loaded) return
		if (this.statePath) {
			try {
				const state = JSON.parse(await readFile(this.statePath, 'utf8')) as { fingerprint?: string; messageId?: number }
				if (state.fingerprint === this.fingerprint() && Number.isSafeInteger(state.messageId) && state.messageId! > 0)
					this.progressId = state.messageId
			} catch (error) {
				if (!(error instanceof Error) || error.code !== 'ENOENT') throw new Error('telegram: could not read progress state')
			}
		}
		this.loaded = true
	}
	private async saveProgress() {
		if (!this.statePath) return
		const temporary = this.statePath + '.' + process.pid + '.tmp'
		await writeFile(temporary, JSON.stringify({ fingerprint: this.fingerprint(), messageId: this.progressId }), { mode: 0o600 })
		await rename(temporary, this.statePath)
	}
	private async telegramProgress(message: string): Promise<string[]> {
		const telegram = this.config?.telegram
		if (!telegram) return []
		if (Date.now() < this.retryAt) return []
		try {
			await this.loadProgress()
			const text = message.slice(0, 4000)
			if (this.progressId && text === this.progressText) return []
			for (let attempt = 0; attempt < 2; attempt++) {
				const editing = this.progressId !== undefined
				const response = await this.request(`https://api.telegram.org/bot${telegram.token}/${editing ? 'editMessageText' : 'sendMessage'}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						chat_id: telegram.chatId,
						...(editing ? { message_id: this.progressId } : { disable_notification: true }),
						text,
						...(telegram.controls ? { reply_markup: controlKeyboard } : {}),
						link_preview_options: { is_disabled: true }
					}),
					signal: AbortSignal.timeout(10_000),
					redirect: 'error'
				})
				const body = (await response.json()) as {
					ok?: boolean
					result?: { message_id?: number }
					description?: string
					parameters?: { retry_after?: number }
				}
				if (response.status === 429) {
					this.retryAt = Date.now() + Math.max(1, Math.min(86400, Number(body.parameters?.retry_after) || 60)) * 1000
					return ['telegram: rate limited; progress update deferred']
				}
				if (editing && response.status === 400 && /message is not modified/i.test(body.description ?? '')) {
					this.progressText = text
					return []
				}
				if (editing && response.status === 400 && /message to edit not found|message can.t be edited/i.test(body.description ?? '')) {
					this.progressId = undefined
					continue
				}
				if (!response.ok || !body.ok) return ['telegram: progress update rejected (HTTP ' + response.status + ')']
				if (!editing) {
					if (!Number.isSafeInteger(body.result?.message_id) || body.result!.message_id! <= 0) return ['telegram: missing message ID']
					this.progressId = body.result!.message_id
				}
				await this.saveProgress()
				this.progressText = text
				return []
			}
			return ['telegram: could not recreate progress message']
		} catch {
			return ['telegram: progress update or state save failed']
		}
	}
	async send(event: string, message: string) {
		if (event === 'progress') return this.telegramProgress(message)
		const key = event + ':' + message
		if ((this.sent.get(key) ?? 0) > Date.now() - 900_000) return []
		const destinations: { name: string; url: string; body: unknown }[] = []
		if (this.config?.telegram) {
			const { token, chatId } = this.config.telegram
			destinations.push({
				name: 'telegram',
				url: `https://api.telegram.org/bot${token}/sendMessage`,
				body: { chat_id: chatId, text: message.slice(0, 4000) }
			})
		}
		if (this.config?.discord)
			destinations.push({
				name: 'discord',
				url: this.config.discord.webhook,
				body: { content: message.slice(0, 1900), allowed_mentions: { parse: [] } }
			})
		if (this.config?.webhook) destinations.push({ name: 'webhook', url: this.config.webhook.url, body: { event, message } })
		const results = await Promise.all(
			destinations.map(async target => {
				try {
					const response = await this.request(target.url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(target.body),
						signal: AbortSignal.timeout(10_000),
						redirect: 'error'
					})
					if (!response.ok) return target.name + ': HTTP ' + response.status
					if (target.name === 'telegram' && !((await response.json()) as { ok?: boolean }).ok) return 'telegram: rejected'
					return null
				} catch {
					return target.name + ': delivery failed'
				}
			})
		)
		if (results.every(result => result === null)) this.sent.set(key, Date.now())
		for (const [id, time] of this.sent) if (time < Date.now() - 900_000) this.sent.delete(id)
		return results.filter((value): value is string => value !== null)
	}
}
