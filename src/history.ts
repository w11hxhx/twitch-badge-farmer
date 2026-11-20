import { readFile, writeFile, rename } from 'node:fs/promises'

export interface StreamHistory {
	averageMinutes: number
	streamsPerDay: number
	samples: number
	source: 'lurkology' | 'fallback'
	sourceUrl: string
	fetchedAt: number
}

export function parseHistory(html: string, login: string, now = Date.now()): StreamHistory | null {
	const text = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;|&#160;/g, ' ')
		.replace(/\s+/g, ' ')
	const match = text.match(/(?:last|past)\s+(\d+)\s+days[\s\S]{0,120}?streamed\s+([\d,.]+)\s*h(?:\s*(\d+)\s*m)?\s+across\s+([\d,]+)\s+streams/i)
	if (!match) return null
	const days = Number(match[1]),
		minutes = Number(match[2]!.replaceAll(',', '')) * 60 + Number(match[3] || 0),
		samples = Number(match[4]!.replaceAll(',', ''))
	if (!(days > 0 && days <= 365 && samples > 0 && minutes > 0 && minutes <= days * 1440)) return null
	return {
		averageMinutes: minutes / samples,
		streamsPerDay: samples / days,
		samples,
		source: 'lurkology',
		sourceUrl: `https://lurkology.com/${login}/streams`,
		fetchedAt: now
	}
}

export class Histories {
	cache = new Map<string, StreamHistory>()
	private attempts = new Map<string, number>()
	private loaded = false
	constructor(
		private path?: string,
		private request: typeof fetch = fetch,
		private readOnly = false
	) {}
	async load() {
		if (this.loaded) return
		if (this.path) {
			try {
				const entries = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, StreamHistory>
				for (const [login, value] of Object.entries(entries))
					if (
						value.source === 'lurkology' &&
						value.averageMinutes > 0 &&
						value.averageMinutes <= 1440 * 30 &&
						value.streamsPerDay > 0 &&
						Number.isFinite(value.fetchedAt)
					)
						this.cache.set(login, value)
			} catch (error) {
				if (!(error instanceof Error) || error.code !== 'ENOENT') throw new Error('History | Could not read history cache')
			}
		}
		this.loaded = true
	}
	async refresh(logins: string[], enabled = true) {
		await this.load()
		if (!enabled) return
		const queue = [...new Set(logins)].filter(
			login => /^[a-z0-9_]{1,25}$/.test(login) && Date.now() - (this.attempts.get(login) ?? this.cache.get(login)?.fetchedAt ?? 0) >= 21_600_000
		)
		await Promise.all(
			Array.from({ length: Math.min(3, queue.length) }, async () => {
				for (;;) {
					const login = queue.shift()
					if (!login) break
					this.attempts.set(login, Date.now())
					try {
						const response = await this.request(`https://lurkology.com/${login}/streams`, {
							headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadgeFarmer/1.3; stream-duration-estimates)' },
							signal: AbortSignal.timeout(8000),
							redirect: 'error'
						})
						if (!response.ok) {
							await response.body?.cancel()
							continue
						}
						const parsed = parseHistory(await response.text(), login)
						if (parsed) this.cache.set(login, parsed)
					} catch {
						/* history is advisory; Twitch viewing continues on failure */
					}
				}
			})
		)
		if (this.path && !this.readOnly) {
			const temporary = this.path + '.' + process.pid + '.tmp'
			await writeFile(temporary, JSON.stringify(Object.fromEntries(this.cache)), { mode: 0o600 })
			await rename(temporary, this.path)
		}
	}
	get(login: string, now = Date.now()): StreamHistory {
		const cached = this.cache.get(login)
		if (cached && now - cached.fetchedAt <= 604_800_000) return cached
		return {
			averageMinutes: 240,
			streamsPerDay: 0.5,
			samples: 0,
			source: 'fallback',
			sourceUrl: `https://lurkology.com/${login}/streams`,
			fetchedAt: now
		}
	}
}
