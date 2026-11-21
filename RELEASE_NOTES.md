# Twitch Badge Farmer v1.4.0

## Русский

- Фармятся только креаторские бейджи каналов за просмотр. Игровые Drops, монеты и остальные награды исключены, в том числе из сохранённой очереди.
- Telegram: кнопки добавления/удаления каналов, список бейджей и выбор приоритетного бейджа или канала.
- Команды `/add`, `/remove`, `/channels`, `/priority_badge`, `/priority_channel`, `/menu`, `/cancel`. `none` снимает приоритет.
- Управление включается через `notifications.telegram.controls: true`; команды принимает только владелец указанного личного чата. Настройки сохраняются после перезапуска.
- Просмотр при достижении 100% больше не занимает поток, даже если получение ещё ожидает подтверждения Twitch.

## English

- Farms only creator channel watch badges. Game Drops, coins and other rewards are excluded, including from persisted queues.
- Telegram buttons for adding/removing channels, browsing badges, and choosing a priority badge or channel.
- Commands: `/add`, `/remove`, `/channels`, `/priority_badge`, `/priority_channel`, `/menu`, `/cancel`. Use `none` to clear a priority.
- Enable with `notifications.telegram.controls: true`. Only the configured private chat owner can change settings; settings persist across restarts.
- Fully watched rewards no longer consume a viewing slot while Twitch claim confirmation is pending.
