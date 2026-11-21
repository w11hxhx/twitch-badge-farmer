# Badge Farmer

[English version](README.md)

Форк [FrostyDeFreeze/twitch-badge-farmer](https://github.com/FrostyDeFreeze/twitch-badge-farmer)
для сбора креаторских бейджей каналов за просмотр трансляций Twitch.

Программа находит доступные бейджи у фолловов, проверяет прогресс через Twitch
и переключает каналы после получения наград. Можно выбрать приоритетный бейдж
или канал. Порядок просмотра также учитывает оставшееся время, сроки наград
и историю эфиров из [Lurkology](https://lurkology.com).

## Установка

Скачайте архив из [Releases](https://github.com/w11hxhx/twitch-badge-farmer/releases)
и распакуйте в папку для программы и её настроек.

| Система             | Архив                             |
| ------------------- | --------------------------------- |
| Windows x64         | `badge-farmer-windows-x64.zip`    |
| Linux x64           | `badge-farmer-linux-x64.tar.gz`   |
| macOS Apple Silicon | `badge-farmer-macos-arm64.tar.gz` |
| macOS Intel         | `badge-farmer-macos-x64.tar.gz`   |

Откройте терминал в этой папке и авторизуйтесь в Twitch:

```powershell
.\badge-farmer.exe --gen-token
```

На Linux или macOS:

```sh
./badge-farmer --gen-token
```

Завершите авторизацию в браузере. Программа создаст `config.json`.
Храните этот файл приватно: он содержит токен доступа.

## Использование

Запустите `badge-farmer.exe` на Windows или `./badge-farmer` на Linux и macOS.
Для остановки нажмите **Ctrl+C**. При следующем запуске прогресс восстанавливается
из Twitch и сохранённого состояния.

| Команда                            | Описание                                     |
| ---------------------------------- | -------------------------------------------- |
| `--list`                           | Доступные бейджи без запуска просмотра       |
| `--channels`                       | Все фолловы, включая офлайн-каналы           |
| `--eligible-channels`              | Бейджи, каналы, прогресс и сроки доступности |
| `--plan`                           | Текущий порядок просмотра                    |
| `--set-priority "Название бейджа"` | Приоритет бейджа по названию или ID          |
| `--set-priority none`              | Снять приоритет бейджа                       |
| `--gen-token`                      | Авторизация аккаунта Twitch                  |
| `--help`                           | Все параметры запуска                        |

Для другой конфигурации используйте `--config account.json`.
Списки каналов и текущий план можно получить в JSON с параметром `--json`.

Фолловы перепроверяются каждые три минуты. Новые доступные бейджи добавляются;
полученные, истёкшие или недоступные награды и каналы после отписки убираются
из очереди. Вручную добавленные каналы сохраняются. Одновременно смотрятся
не более двух потоков; параллельный прогресс проверяется по счётчикам Twitch.

## Уведомления и управление через Telegram

Уведомления включаются по желанию. Добавьте в `config.json` только нужные адресаты:

```json
{
	"notifications": {
		"telegram": { "token": "123456:BOT_TOKEN", "chatId": "123456", "controls": true },
		"discord": { "webhook": "https://discord.com/api/webhooks/123456/WEBHOOK_TOKEN" },
		"webhook": { "url": "https://example.com/notifications" }
	}
}
```

Telegram редактирует сохранённое сообщение прогресса. При `controls: true`
его кнопки позволяют добавлять и исключать каналы для бейджей, выбирать
приоритетный бейдж или канал. Команды принимает только владелец указанного
личного чата:

```text
/add channel_name
/remove channel_name
/priority_badge Название бейджа
/priority_channel channel_name
/channels
/menu
/cancel
```

Значение `none` снимает приоритет. Проверить настроенные уведомления можно
командой `--test-notifications`.

## Установка из исходников

Нужен [Bun](https://bun.sh) версии 1.4.3 или новее.

```sh
bun install --frozen-lockfile
bun run gen-token
bun start
```

Проверка и сборка исполняемого файла:

```sh
bun run typecheck
bun test src
bun run format:check
bun run build
```

Результат — `dist/badge-farmer` (на Windows — `.exe`).

## Ограничения

Собираются только бейджи за просмотр. Платные награды и условия с подписками
пропускаются. Получение и прогресс подтверждает Twitch; одного локального
таймера недостаточно. Оценки по истории эфиров не гарантируют получение награды.

Программа использует внутренние API Twitch, которые могут меняться.
Запускайте один экземпляр на аккаунт.

## Исходный проект

Основан на [Twitch Badge Farmer от FrostyDeFreeze](https://github.com/FrostyDeFreeze/twitch-badge-farmer).
[Лицензия MIT](LICENSE).
