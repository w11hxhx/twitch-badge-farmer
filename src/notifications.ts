import type { Config } from './types.ts'

export class Notifications {
	private sent = new Map<string, number>()
	constructor(
		private config: Config['notifications'],
		private request: typeof fetch = fetch
	) {}
	async send(event: string, message: string) {
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
