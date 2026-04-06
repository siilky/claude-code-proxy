# Спецификация: OAuth-аутентификация через Claude.ai

## Что такое OAuth простыми словами

OAuth — это способ получить доступ к чужому сервису **без передачи логина и пароля**. Вместо этого:

1. Ты перенаправляешь пользователя на сайт Claude.ai
2. Пользователь сам вводит свой логин/пароль **на сайте Claude.ai** (не у тебя)
3. Claude.ai даёт тебе **временный ключ** (access token), которым можно делать API-запросы
4. Когда ключ истекает, ты обмениваешь **refresh token** на новый ключ — без участия пользователя

Аналогия: это как доверенность. Пользователь говорит Claude.ai: "Я разрешаю этому приложению действовать от моего имени". Claude.ai выдаёт "доверенность" (token) твоему приложению.

## Что такое PKCE

PKCE (Proof Key for Code Exchange) — это дополнительная защита для OAuth. Проблема без PKCE: если кто-то перехватит authorization code, он сможет обменять его на токен. PKCE решает это так:

1. Перед началом ты генерируешь **случайную строку** (`code_verifier`) и сохраняешь её у себя
2. Вычисляешь от неё **хэш** (`code_challenge`) и отправляешь хэш в Claude.ai
3. Когда обмениваешь код на токен, отправляешь **оригинальную строку** (`code_verifier`)
4. Claude.ai проверяет, что хэш оригинальной строки совпадает с тем, что ты отправлял ранее

Таким образом, даже если кто-то перехватит authorization code, он не сможет получить токен — у него нет `code_verifier`.

---

## Фиксированные параметры (специфичны для Claude.ai)

```
client_id:      9d1c250a-e61b-44d9-88ed-5944d1962f5e
authorize_url:  https://claude.ai/oauth/authorize
token_url:      https://console.anthropic.com/v1/oauth/token
redirect_uri:   https://console.anthropic.com/oauth/code/callback
scope:          org:create_api_key user:profile user:inference
```

- `client_id` — идентификатор "приложения" в глазах Claude.ai. Здесь используется ID, зашитый в Claude Code.
- `redirect_uri` — куда Claude.ai отправит пользователя после авторизации. Здесь используется страница Anthropic, которая **показывает код пользователю на экране** (а не перенаправляет на твой сервер). Это из-за того что у локального приложения нет публичного URL.
- `scope` — какие разрешения просишь. `user:inference` — это то, что даёт право делать запросы к API.

---

## Полный процесс аутентификации (пошагово)

### Шаг 1: Генерация PKCE-параметров

Перед каждой попыткой аутентификации генерируешь три значения:

```
code_verifier  = 32 случайных байта -> base64url
code_challenge = SHA-256(code_verifier) -> base64url
state          = 32 случайных байта -> base64url
```

`state` — это защита от CSRF (подделки запросов). Ты запоминаешь его у себя на сервере и потом проверяешь, что вернулось то же значение.

**Важно:** `code_verifier` нужно сохранить в памяти сервера, привязав к `state`. Он понадобится на шаге 4.

### Шаг 2: Отправка пользователя на страницу авторизации

Собираешь URL из параметров:

```
https://claude.ai/oauth/authorize?
  code=true
  &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
  &response_type=code
  &redirect_uri=https://console.anthropic.com/oauth/code/callback
  &scope=org:create_api_key user:profile user:inference
  &code_challenge={code_challenge}
  &code_challenge_method=S256
  &state={state}
```

Параметры:
- `code=true` — обязательно: говорит показать код пользователю на экране
- `response_type=code` — стандартный OAuth: просим authorization code
- `code_challenge_method=S256` — метод хэширования для PKCE

Пользователь открывает этот URL в браузере, логинится (если ещё не залогинен) и нажимает "Authorize".

### Шаг 3: Пользователь получает код

После авторизации Claude.ai перенаправляет пользователя на `redirect_uri` — страницу Anthropic, которая **показывает authorization code на экране**. Формат: `{code}#{state}`.

Пользователь копирует эту строку и вставляет в твоё приложение (через веб-форму, CLI-ввод и т.д.).

Ты парсишь строку, разделяя по `#`:
- Первая часть — `code` (authorization code)
- Вторая часть — `state`

**Проверяешь `state`:** он должен совпадать с тем, что ты сохранил на шаге 1. Если не совпадает — отклоняй (возможная атака).

### Шаг 4: Обмен кода на токены

Отправляешь POST-запрос:

```
POST https://console.anthropic.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "{code из шага 3}",
  "state": "{state из шага 3}",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "{code_verifier из шага 1}",
  "redirect_uri": "https://console.anthropic.com/oauth/code/callback"
}
```

Ответ (JSON):

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3600
}
```

- `access_token` — этим делаешь API-запросы
- `refresh_token` — этим обновляешь access_token когда он истечёт
- `expires_in` — время жизни access_token в секундах

### Шаг 5: Сохранение токенов

Сохраняешь на диск:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": 1712345678000
}
```

`expires_at` = `Date.now() + expires_in * 1000` (абсолютное время в миллисекундах).

Хранить `expires_at` удобнее, чем `expires_in`, потому что при следующем запуске приложения ты сразу видишь, истёк ли токен.

На Linux/Mac: файл должен иметь права `600` (только владелец может читать/писать), потому что в нём секреты.

---

## Использование токенов для API-запросов

### Обычный запрос

Добавляешь access token в заголовок:

```
POST https://api.anthropic.com/v1/messages
Authorization: Bearer {access_token}
anthropic-version: 2023-06-01
anthropic-beta: oauth-2025-04-20
Content-Type: application/json

{ ...тело запроса... }
```

**Ключевой заголовок:** `anthropic-beta: oauth-2025-04-20` — без него OAuth-токены не принимаются.

### Обновление истёкшего токена (refresh)

Перед каждым запросом проверяешь: `expires_at <= сейчас + 60000мс` (буфер в 1 минуту). Если да — обновляешь:

```
POST https://console.anthropic.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "{refresh_token}",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

Ответ — тот же формат, что и в шаге 4. Сохраняешь новые токены поверх старых.

**Важный нюанс:** если ответ содержит новый `refresh_token` — используй его. Если нет — сохраняй старый.

### Автоматический retry при 401

Если API-запрос вернул статус `401 Unauthorized`:
1. Сделай refresh токена (как описано выше)
2. Повтори тот же API-запрос с новым access_token
3. Если снова 401 — аутентификация сломана, нужно повторить весь процесс (шаги 1-5)

### Защита от гонок при refresh

Если несколько запросов одновременно обнаружат, что токен истёк, и все начнут refresh — будет хаос. Решение: сохраняй один Promise на refresh и отдавай его всем ожидающим:

```
if (refreshPromise существует) {
  return await refreshPromise;   // ждём текущий refresh
}
refreshPromise = doRefresh();    // запускаем refresh
try {
  return await refreshPromise;
} finally {
  refreshPromise = null;         // очищаем после завершения
}
```

---

## HTTP-эндпоинты для реализации в приложении

| Эндпоинт | Метод | Что делает |
|---|---|---|
| `/auth/login` | GET | Отдаёт HTML-страницу с кнопкой "Авторизоваться" и формой для ввода кода |
| `/auth/get-url` | GET | Генерирует PKCE, сохраняет `state -> code_verifier` в памяти, возвращает JSON `{ url, state }` |
| `/auth/callback?manual_code={code}#{state}` | GET | Парсит код, проверяет state, обменивает код на токены, сохраняет токены |
| `/auth/status` | GET | Возвращает JSON `{ authenticated: bool, expires_at: string }` |
| `/auth/logout` | GET | Удаляет сохранённые токены |

Хранилище PKCE-состояний (`state -> code_verifier`) — это обычный Map / словарь в памяти с автоочисткой записей старше 10 минут.

---

## Минимальный чеклист для имплементации

1. **Генерация PKCE:** функция, возвращающая `{ code_verifier, code_challenge, state }`
2. **Построение URL авторизации:** из PKCE + фиксированных параметров
3. **Временное хранилище:** `state -> code_verifier` (in-memory, с TTL ~10 минут)
4. **Обмен кода на токены:** POST на token_url с code + code_verifier
5. **Персистентное хранилище токенов:** файл на диске (access_token, refresh_token, expires_at)
6. **Получение валидного токена:** проверка expires_at -> refresh если надо -> возврат access_token
7. **Refresh токена:** POST на token_url с refresh_token, защита от гонок
8. **Retry при 401:** refresh -> повтор запроса
9. **UI:** страница с кнопкой + форма для ввода кода (или CLI-ввод)

---

## Отличия от стандартного OAuth 2.0

Ядро протокола (PKCE, token exchange, refresh) — стандартное и корректное (RFC 6749 + RFC 7636). Ниже перечислены отличия от "учебного" OAuth-потока.

### Ручная передача кода вместо redirect

В стандартном OAuth сервер авторизации перенаправляет браузер пользователя **обратно на твоё приложение** с кодом в URL (`redirect_uri=http://localhost:PORT/callback?code=xxx&state=yyy`). Приложение автоматически получает код.

Здесь используется **"copy-paste" flow**: `redirect_uri` указывает на страницу Anthropic (`console.anthropic.com/oauth/code/callback`), которая просто **показывает код на экране**. Пользователь вручную копирует его и вставляет в форму.

**Почему так:** упрощение для локальных приложений — не нужно слушать callback на localhost, не нужно разбираться с портами. В "нормальной" реализации ты бы поднял временный HTTP-сервер на localhost, указал `redirect_uri=http://localhost:{port}/callback`, и код пришёл бы автоматически.

### Нестандартный параметр `code=true`

В authorization URL передаётся `code=true` — это **не часть стандарта OAuth**. Это проприетарный параметр Claude.ai, который говорит "покажи код пользователю на экране вместо редиректа". Без него поток не работает.

### Формат кода: `code#state`

Стандартный OAuth передаёт `code` и `state` как отдельные query-параметры в redirect URL. Здесь они склеены через `#` в одну строку, которую пользователь копирует. Проприетарное решение Anthropic для copy-paste flow.

### Token endpoint принимает JSON вместо form-urlencoded

По RFC 6749 (Section 4.1.3) token request должен использовать `application/x-www-form-urlencoded`. Здесь используется `application/json`. Работает, потому что Anthropic поддерживает оба формата, но формально это отступление от спецификации.

---

## Потенциальные проблемы

| Проблема | Серьёзность | Пояснение |
|---|---|---|
| Нет валидации `expires_in` из ответа | Низкая | Если сервер вернёт некорректное значение, `expires_at` будет неверным |
| Токены хранятся в plaintext JSON | Средняя | Стандартная практика для CLI-утилит, но для серверного приложения лучше шифровать |
| PKCE state хранится in-memory | Низкая | При перезапуске сервера во время аутентификации state теряется — пользователю придётся начать заново. Для single-server это нормально |
