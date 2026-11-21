import { basename, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { readConfig, validateConfig } from './config.ts'
import { generateToken } from './gen-token.ts'
import { buildTasks, describeSkipped } from './catalog.ts'
import { fetchJson } from './fetch.ts'
import { Twitch } from './twitch.ts'
import { Collector, nextWindowAt } from './collector.ts'
import { FollowDrops } from './follow-drops.ts'
import { Notifications } from './notifications.ts'
import { loadState, saveState } from './state.ts'
import { createLogger, duration } from './logger.ts'
import type { Task } from './types.ts'
import { writeFile, rename, stat, chown } from 'node:fs/promises'
import { version } from '../package.json'

let log = createLogger()

function nextWindow(task: Task, now: number) {
	const at = nextWindowAt(task, now)

	return at === null ? '' : new Date(at).toISOString()
}

function argumentsFor(args: string[]) {
	let mode = 'start'
	let debug = false
	let json = false
	let priorityValue = ''
	let configPath = resolve('config.json')

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!
		const value = args[index + 1]

		if (argument === '--config' && value && !value.startsWith('--')) {
			configPath = resolve(value)
			index++
		} else if (argument === '--set-priority' && value && !value.startsWith('--') && mode === 'start') {
			mode = 'set-priority'
			priorityValue = value
			index++
		} else if (argument === '--debug') {
			debug = true
		} else if (argument === '--json') {
			json = true
		} else if (
			[
				'--help',
				'--version',
				'--list',
				'--gen-token',
				'--scan-follows',
				'--eligible-channels',
				'--channels',
				'--plan',
				'--test-notifications'
			].includes(argument) &&
			mode === 'start'
		) {
			mode = argument.slice(2)
		} else {
			throw new Error('Unknown argument or conflicting modes | Use --help')
		}
	}

	if (json && !['channels', 'eligible-channels', 'scan-follows', 'plan'].includes(mode))
		throw new Error('--json requires --channels or --eligible-channels')
	return { mode, configPath, debug, json, priorityValue }
}

async function main() {
	const { mode, configPath, debug, json, priorityValue } = argumentsFor(process.argv.slice(2))

	log = createLogger({ debug })
	if (mode === 'version') {
		console.log(version)
		return
	}

	if (mode === 'help') {
		const section = (title: string, rows: [string, string][]) => [title, ...rows.map(([name, text]) => '  ' + name.padEnd(24) + text)]

		console.log(
			[
				`Usage: ${Bun.isStandaloneExecutable ? basename(process.execPath) : 'bun src/index.ts'} [mode] [options]`,
				'',
				...section('Modes:', [
					['(none)', 'Collect badges until stopped with Ctrl+C'],
					['--list', 'Show available badges without watching'],
					['--scan-follows', 'Read-only scan for badges on followed live channels'],
					['--eligible-channels', 'List eligible badges, channels, progress and UTC dates'],
					['--channels', 'List ALL followed channels, including offline'],
					['--plan', 'Show badge order, priority, stream estimates and progress'],
					['--set-priority <value>', 'Save priority name/ID, or none; reloads within 3 min'],
					['--test-notifications', 'Send a test to configured notification destinations'],
					['--gen-token', 'Sign in to Twitch and save the config']
				]),
				'',
				...section('Options:', [
					['--config <file>', 'Use another config file (default: config.json)'],
					['--debug', 'Show technical details and skipped badges'],
					['--json', 'Machine-readable output for channel/reward lists'],
					['--help', 'Show this help']
				])
			].join('\n')
		)

		return
	}

	const controller = new AbortController()

	if (mode === 'gen-token') {
		const stop = () => controller.abort(new Error('Token generation cancelled'))

		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)

		try {
			await generateToken(configPath, controller.signal, log)
		} finally {
			process.off('SIGINT', stop)
			process.off('SIGTERM', stop)
		}

		return
	}

	const config = validateConfig(await readConfig(configPath))
	if (mode === 'set-priority') {
		const record = (await readConfig(configPath)) as Record<string, unknown>
		const scheduler = { ...config.scheduler }
		if (priorityValue.toLowerCase() === 'none') delete scheduler.priorityReward
		else scheduler.priorityReward = priorityValue
		record.scheduler = scheduler
		validateConfig(record)
		const temporary = configPath + '.' + process.pid + '.tmp'
		const owner = await stat(configPath)
		await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
		if (process.platform !== 'win32') await chown(temporary, owner.uid, owner.gid)
		await rename(temporary, configPath)
		console.log('Priority saved | ' + (scheduler.priorityReward ?? 'none') + ' | Reload within 3 min')
		return
	}

	log = createLogger({ debug, token: config.token })
	if (mode === 'test-notifications') {
		if (!config.notifications || !Object.keys(config.notifications).length) throw new Error('Notifications | No destinations configured')
		const errors = await new Notifications(config.notifications).send('test', 'Twitch farmer notification test')
		if (errors.length) throw new Error(errors.join(' | '))
		log.success('Notification test delivered')
		return
	}
	if (mode === 'channels') {
		const channels = (await new Twitch(config, controller.signal, log).followedChannels()).sort((a, b) => a.login.localeCompare(b.login))
		if (json) console.log(JSON.stringify(channels, null, 2))
		else {
			console.table(channels.map(c => ({ channel: c.login, status: c.live ? 'LIVE' : 'OFFLINE', url: 'https://www.twitch.tv/' + c.login })))
			log.info(`${channels.length} followed channels | ${channels.filter(c => c.live).length} live`)
		}
		return
	}
	if (mode === 'scan-follows' || mode === 'eligible-channels' || mode === 'plan' || (mode === 'list' && config.followDrops)) {
		const safe = { ...config }
		delete safe.notifications
		const listLog = json ? createLogger({ silent: true, token: config.token }) : log
		const follow = new FollowDrops(new Twitch(safe, controller.signal, listLog), undefined, configPath, true)
		await follow.scan()
		const rows = follow.rows()
		if (mode === 'plan') {
			const plan = follow.plan()
			if (json)
				console.log(
					JSON.stringify(
						{ rewards: plan.rows, warnings: [...follow.scanWarnings, ...plan.warnings], assumedSlots: plan.assumedSlots },
						null,
						2
					)
				)
			else {
				console.table(plan.rows)
				for (const warning of plan.warnings) log.warn(warning)
			}
			return
		}
		if (json) console.log(JSON.stringify({ rewards: rows, warnings: follow.scanWarnings }, null, 2))
		else console.table(rows.map(row => ({ ...row, channels: row.channels.join(', ') })))
		return
	}

	if (mode === 'list') {
		const twitch = new Twitch(config, controller.signal, log)
		const [catalog, globals, owned, campaigns] = await Promise.all([
			fetchJson('https://api.streamdatabase.com/events', { signal: controller.signal, label: 'StreamDatabase' }),
			twitch.globalBadges(),
			twitch.badges(),
			twitch.inventory()
		])

		const now = Date.now()
		const { tasks, skipped } = buildTasks(catalog, owned, now, globals, campaigns)

		console.table(
			tasks.map(task => ({
				title: task.title,
				viewing: task.days ? task.minutes + ' min/day × ' + task.days + ' days' : task.minutes + ' min',
				progress: task.daily
					? task.daily.completedDays + '/' + task.daily.requiredDays + ' days, ' + task.serverMinutes + '/' + task.minutes + ' min today'
					: '',
				nextWindowUTC: nextWindow(task, now),
				categories: (task.categoryNames[0] || 'Any') + (task.categoryNames.length > 1 ? ' + ' + (task.categoryNames.length - 1) : ''),
				channels: task.channels.map(channel => channel.login).join(', ') || 'Any eligible channel'
			}))
		)

		log.info(`Found ${tasks.length} available badge${tasks.length === 1 ? '' : 's'}`)
		log.debug(`[CATALOG] Refreshed | Available: ${tasks.length} | Skipped: ${skipped.length}`)

		for (const message of describeSkipped(skipped)) {
			log.debug(message)
		}

		return
	}

	const statePath = configPath + '.state.json'
	const state = await loadState(statePath, config.id)
	const collector = config.followDrops
		? new FollowDrops(new Twitch(config, controller.signal, log), configPath + '.notifications.state.json', configPath)
		: new Collector({
				config,
				signal: controller.signal,
				twitch: new Twitch(config, controller.signal, log),
				state,
				save: value => saveState(statePath, value),
				log
			})

	const stop = () => controller.abort(new Error('Shutdown requested'))
	const onMessage = (message: unknown) => {
		if (message === 'shutdown') stop()
	}

	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	process.on('message', onMessage)

	let failures = 0

	try {
		log.info('Account: ' + config.login)
		log.debug('[SYSTEM] State file | ' + statePath)

		while (!controller.signal.aborted) {
			let delay

			try {
				delay = await collector.step()
				failures = 0
			} catch (error) {
				if (!(error instanceof Error)) throw error

				if (controller.signal.aborted) break
				if (error.fatal) throw error

				collector.interrupt()
				failures++

				delay = Math.max(Math.min(10_000 * 2 ** Math.min(failures - 1, 5), 300_000), error.retryAfterMs || 0)

				log.warn(`Could not update reward data | Retrying in ${duration(delay)}`)
				log.debug('[SYSTEM] Step failed | ' + error.message)
			}

			try {
				await pause(Math.max(1, delay), undefined, { signal: controller.signal })
			} catch (error) {
				if (!(error instanceof Error)) throw error

				if (!controller.signal.aborted) throw error
			}
		}
	} finally {
		process.off('message', onMessage)

		await collector.persist()

		log.info('Stopped | State saved')
	}
}

main().catch(error => {
	log.error(error instanceof Error ? error.message : 'Unexpected failure')

	process.exitCode = 1
})
