# Twitch Badge Farmer v1.4.1

## Русский

- Просроченное подтверждение нажатия Telegram больше не мешает открыть меню или применить действие.
- Добавлена обработка обновлений от единого получателя общего бота без запуска второго `getUpdates`.
- Состояние меню и ожидаемый ввод сохраняются при такой передаче обновлений и восстанавливаются после перезапуска.
- Фарм по-прежнему ограничен креаторскими бейджами каналов.

## English

- An expired Telegram callback acknowledgement no longer prevents menus or actions from working.
- Shared bots can forward updates from one existing consumer without starting a second `getUpdates` loop.
- Forwarded-update menus and pending input persist across restarts.
- Farming remains limited to creator channel badges.
