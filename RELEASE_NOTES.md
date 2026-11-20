# Badge Farmer v1.3.0

Форк [Twitch Badge Farmer от FrostyDeFreeze](https://github.com/FrostyDeFreeze/twitch-badge-farmer)
для бейджей каналов и Drops: поиск наград у фолловов и выбор каналов по
дедлайнам, приоритетам и истории эфиров.

A fork of [FrostyDeFreeze's Twitch Badge Farmer](https://github.com/FrostyDeFreeze/twitch-badge-farmer)
for channel badges and Drops, with followed-channel discovery and channel selection
based on deadlines, pinned priorities and stream history.

## Русский

- Умная очередь вместо алфавитной ротации: дедлайны, остаток просмотра и доступное эфирное время.
- Оценки длительности и частоты стримов из Lurkology, кеш, запас времени и явный запасной прогноз.
- Закреплённый приоритет по названию/ID; сохранение через `--set-priority`, отмена — `none`.
- До двух независимых потоков; проверка параллельного зачёта Twitch и защита прогресса приоритета.
- `--plan`, списки каналов/наград, JSON, сроки UTC, риски и конфликты общей нагрузки.
- Сохранение известных офлайн-наград, исправление дублей API и ложного нулевого прогресса.
- Редактируемая Telegram-карточка и уведомления Discord/HTTPS.
- Русская/английская документация, четыре платформы и контрольные суммы SHA-256.

Все дедлайны нельзя гарантировать без достаточного реального эфирного времени и зачёта Twitch.
Второй поток не считается гарантированной ёмкостью, пока не подтверждён прогресс обоих.

## English

- Reward collection takes remaining watch time and reward expiration into account.
- Lurkology stream-duration/frequency estimates, caching, safety margin and explicit fallback forecasts.
- Pinned priority by name/ID using `--set-priority`; clear it with `none`.
- Up to two independent playback sessions, Twitch-confirmed parallel credit and priority protection.
- `--plan`, channel/reward lists, JSON, UTC windows, risk and shared workload warnings.
- Persistence of discovered offline rewards; fixes for duplicate APIs and misleading zero progress.
- Editable Telegram progress card and Discord/HTTPS notifications.
- English/Russian documentation, four platform archives and SHA-256 checksums.

Meeting every deadline requires sufficient real airtime and Twitch credit; it cannot be guaranteed.
A second stream is not assumed to provide guaranteed capacity until both server counters advance.
