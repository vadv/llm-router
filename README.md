# llm-router

OpenAI-compatible LLM-прокси для личного использования. Объединяет модели разных провайдеров в пулы и закрепляет ответившую модель за разговором. Написан на Rust, хранит данные в SQLite и работает на слабых ARM-процессорах.

## Как это работает

Пул задаёт порядок моделей и получает имя метамодели. Клиент отправляет запрос на это имя, а llm-router выбирает модель из пула.

```text
Provider A                   Provider B
  model-a1                     model-b1
  model-a2                     model-b2
      \                            /
       \                          /
        +-----------+------------+
                    |
                    v
               Pool "coding"
               1. model-a1
               2. model-b1
                    |
                    v
             Metamodel "coding"
                    |
                    v
       Client requests model="coding"
```

Например, в пуле `coding` сначала локальный Qwen, затем DeepSeek. Если Qwen недоступен, тот же запрос уходит в DeepSeek: **один запрос, две попытки**. Если DeepSeek ответил, разговор продолжится с ним. Новый разговор начнётся с первой доступной модели.

Некорректный клиентский запрос роутер не повторяет. Если ответ уже начал передаваться и оборвался, другая модель его не продолжает.

[Собрать пул в чате](#соберите-пул-в-чате) · [Model Wiki](#model-wiki) · [Журнал запросов](#журнал-запросов) · [Балансы и расход](#балансы-и-расход) · [Провайдеры](#поддерживаемые-провайдеры) · [Сборки](#готовые-сборки) · [Запуск](#запуск)

## Соберите пул в чате

> Собери пул `coding` для правок в репозитории. Сначала локальная модель, запасная — у другого провайдера.

Чат предлагает модели из ваших провайдеров и создаёт пул после подтверждения. На скриншотах — демонстрационные данные.

[![Слева — чат подбирает модели и вызывает pool_create. Справа — сохранённый пул coding: сначала llama.cpp, затем OpenRouter.](assets/readme/chat-to-pool.webp)](assets/readme/chat-to-pool.webp)

## Model Wiki

Сильные и слабые стороны моделей, результаты тестов и ID моделей у провайдеров.

[![Каталог Model Wiki с провайдерами и карточка Qwen3 Coder с назначением модели и точным ID на OpenRouter.](assets/readme/model-wiki.webp)](assets/readme/model-wiki.webp)

## Журнал запросов

В **Requests** видны попытки, токены, длительность и причины переключения. Фильтры: период, пул, ключ, подключение и модель.

[![В журнале выбран интервал 15:00–16:00. У запроса к пулу fast две попытки: DeepSeek вернул 429, затем GLM ответила.](assets/readme/request-trace.webp)](assets/readme/request-trace.webp)

## Балансы и расход

**Balances** — остатки и квоты. **Usage** — токены и стоимость за период с разбивкой по моделям, подключениям, пулам и ключам. Если точной стоимости нет, показывается оценка по балансу.

[![Квоты Z.AI и отчёт Usage за неделю: входные и выходные токены с разбивкой по моделям](assets/readme/balances-and-usage.webp)](assets/readme/balances-and-usage.webp)

## Поддерживаемые провайдеры

| Провайдер | Значение `driver` в конфигурации |
| --- | --- |
| [DeepSeek](https://platform.deepseek.com/) | `deepseek` |
| [Kimi](https://www.kimi.ai/) | `kimi` |
| [Z.AI](https://z.ai/) | `zai` |
| [Alibaba Cloud Model Studio](https://www.alibabacloud.com/en/product/modelstudio) | `alibaba` |
| [MiMo](https://github.com/XiaomiMiMo/MiMo) | `mimo` |
| [NVIDIA](https://build.nvidia.com/) | `nvidia` |
| [OpenRouter](https://openrouter.ai/) | `openrouter` |
| [OpenCode](https://opencode.ai/) | `opencode` |
| [Tokenator](https://tokenator.cloud/) | `tokenator` |
| [WorkBuddy](https://www.workbuddy.ai/) | `workbuddy` |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `llamacpp` |
| [Strata](https://github.com/niko1221/strata) | `strata` |

Драйвер преобразует параметры запроса и формат ответа под API провайдера. Баланс запрашивается, если провайдер предоставляет такой API. Для llama.cpp и Strata драйверы также ждут загрузку модели и запуск движка.

## Готовые сборки

https://github.com/vadv/llm-router/releases

Linux x86_64 и ARM64 (статический musl), macOS Apple Silicon и Intel, OpenWrt ARM64 (GL-MT6000).

## Запуск

Для сборки нужны Rust с поддержкой edition 2024 и Node.js 22.

```sh
git clone https://github.com/vadv/llm-router.git
cd llm-router
```

Создайте `config.yaml`:

```yaml
listen: "127.0.0.1:8090"
data_dir: ".data"

client_keys:
  - alias: "local"
    secret: "replace-with-a-long-random-client-key"

providers:
  - provider_id: "openrouter"
    driver: "openrouter"
    base_url: "https://openrouter.ai/api/v1"
    api_key: "replace-with-your-openrouter-key"
```

Замените оба ключа. Ключ из `client_keys` используют локальные клиенты; ключ провайдера остаётся на роутере. Не публикуйте `config.yaml`: он исключён из Git.

```sh
cargo run -- config.yaml
```

Откройте `http://127.0.0.1:8090`, создайте пул в разделе Pools и выберите его в чате. Для API используйте клиентский ключ:

```sh
curl http://127.0.0.1:8090/v1/models \
  -H "Authorization: Bearer replace-with-a-long-random-client-key"
```

У встроенного HTTP-сервера нет TLS. Не открывайте его порт в интернет напрямую; используйте VPN или HTTPS reverse proxy.

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE). Уведомления сторонних компонентов находятся в [web/public/THIRD_PARTY_NOTICES.txt](web/public/THIRD_PARTY_NOTICES.txt).
