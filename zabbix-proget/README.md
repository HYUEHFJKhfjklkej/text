# Zabbix-агент для хоста ProGet

Всё нужное в одной папке. Сервер Zabbix 5.0.26, агент 5.0.46 той же LTS-линии.

| Файл | Что |
|---|---|
| `70-proget-zabbix-agent.sh` | установка и настройка агента на хосте ProGet |
| `zabbix_agent-5.0.46-linux-3.0-amd64-static.tar.gz` | статический агент с cdn.zabbix.com, 2 МБ |
| `SHA256SUMS` | контрольная сумма тарбола |
| `proget-by-agent-5.0.xml` | шаблон для импорта на сервер Zabbix |

## На хосте ProGet

```bash
git clone https://github.com/npushkarev/text.git -b add-hello-txt
cd text/zabbix-proget
sha256sum -c SHA256SUMS

sudo ZBX_SERVER=<IP zabbix-сервера> \
     AGENT_TGZ=$PWD/zabbix_agent-5.0.46-linux-3.0-amd64-static.tar.gz \
     bash 70-proget-zabbix-agent.sh
```

`ZBX_SERVER` только IP, не имя. Статический агент падает на DNS, скрипт это
проверяет и с именем не запустится.

Если агент на хосте уже стоит, `AGENT_TGZ` не нужен: скрипт увидит его и
только допишет конфиг.

В конце скрипт сам прогоняет `zabbix_get` по всем ключам. Ожидается:

```
agent.ping                               1
proget.health[serviceStatus]             OK
proget.health[databaseStatus]            OK
proget.health[licenseStatus]             OK
proget.container.state[proget-server]    running
proget.container.state[proget-database]  running
proget.cert.days                         <число дней>
```

## На сервере Zabbix

1. `Configuration > Templates > Import`, файл `proget-by-agent-5.0.xml`.
2. `Configuration > Hosts > Create host`. Имя РОВНО как `hostname -f` на
   ProGet, буква в букву: проверки активные, сервер узнаёт хост по имени.
   Интерфейс Agent нужен формально, IP хоста, порт 10050.
3. Привязать шаблоны `ProGet by Zabbix agent` и `Template OS Linux by Zabbix agent`.
4. Через пару минут в `Latest data` по хосту появятся `ProGet: *` и
   `Container proget-server: *`.

## Что мониторится

| Ключ | Триггер |
|---|---|
| `proget.health[serviceStatus]` | не `OK`; нет данных 10 мин |
| `proget.health[databaseStatus]` | не `OK` |
| `proget.health[licenseStatus]` | не `OK` (нарушения лицензии Free Edition) |
| `proget.health.rtt` | дольше 3 с пять минут |
| `proget.container.state[...]` | не `running` |
| `proget.container.restarts[...]` | перезапуск |
| `proget.cert.days` | меньше 14 дней, либо сертификат не читается |

Пороги в макросах шаблона: `{$PROGET.RTT.MAX}`, `{$PROGET.CERT.MIN}`.

## Что учтено

- Все проверки активные. Файрвол на хосте ProGet открывает только 22, 80,
  443, и 10050 туда добавлять не надо. Агент сам ходит на сервер, порт 10051
  исходящий.
- `curl --noproxy '*'`: корпоративный прокси перехватывает запросы на
  127.0.0.1 и отдаёт свой 302 вместо ProGet.
- Пользователь `zabbix` добавляется в группу `docker` ради `docker inspect`.
  Это равно root на хосте. Если политика не позволяет, уберите `usermod` в
  скрипте, контейнерные ключи будут отдавать `missing`.
- Размер `/var/proget` не считается через `du`: на больших данных он не
  укладывается в таймаут. Диск покрывает `Template OS Linux by Zabbix agent`.
