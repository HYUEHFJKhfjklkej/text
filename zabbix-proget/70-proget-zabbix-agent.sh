#!/bin/bash
# 70-proget-zabbix-agent.sh — поставить и настроить Zabbix-агента на уже
# работающем хосте ProGet. Один скрипт, запускается на самом хосте под root.
#
# Что делает:
#   1. Если агент уже стоит (роль inc_elara.platform.zabbix_agent из baseline),
#      НЕ переставляет его: только добавляет конфиг под ProGet и перезапускает.
#   2. Если агента нет, ставит статический бинарник zabbix_agentd 5.0 из
#      тарбола (AGENT_TGZ), заводит пользователя, systemd-юнит, конфиг.
#   3. В обоих случаях пишет /etc/zabbix/zabbix_agentd.d/proget.conf с
#      UserParameter'ами под ProGet: /health, состояние контейнеров, диск,
#      срок сертификата.
#
# Сервер Zabbix 5.0.26. Агент 5.0.x той же LTS-линии. Берётся именно agentd
# (агент 1): статических сборок агента 2 для 5.0 у Zabbix нет, а пакетов 5.0
# под Debian 13 тоже нет. Статик работает на любом glibc.
#
# Запуск:
#   ZBX_SERVER=zabbix.inc.elara.local ./70-proget-zabbix-agent.sh
#   ZBX_SERVER=... AGENT_TGZ=/tmp/zabbix_agent-5.0.46-linux-3.0-amd64-static.tar.gz ./70-proget-zabbix-agent.sh
#   DRY_RUN=1 ZBX_SERVER=... ./70-proget-zabbix-agent.sh
#
# Env:
#   ZBX_SERVER    IP Zabbix-сервера (обязателен). Можно несколько через запятую.
#                 ИМЕННО IP, не имя: статический glibc в бинарнике агента падает
#                 на DNS (SIGSEGV в active checks), потому что тянет NSS-модули
#                 хоста от другой версии glibc. Числовой адрес обходит NSS.
#   ZBX_HOSTNAME  имя хоста в Zabbix (по умолч. hostname -f, то есть proget_fqdn)
#   AGENT_TGZ     тарбол статического агента; нужен только если агента нет
#   PROGET_URL    адрес ProGet на loopback (по умолч. http://127.0.0.1:8624)
#   PROGET_FQDN   внешнее имя для проверки сертификата (по умолч. hostname -f)
#   PROGET_DATA   каталог данных (по умолч. /var/proget)
#   CONTAINERS    контейнеры для проверки (по умолч. proget-server proget-database)
#   DRY_RUN=1     показать, что будет сделано
set -euo pipefail

ZBX_SERVER="${ZBX_SERVER:-}"
ZBX_HOSTNAME="${ZBX_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
AGENT_TGZ="${AGENT_TGZ:-}"
PROGET_URL="${PROGET_URL:-http://127.0.0.1:8624}"
PROGET_FQDN="${PROGET_FQDN:-$(hostname -f 2>/dev/null || hostname)}"
PROGET_DATA="${PROGET_DATA:-/var/proget}"
CONTAINERS="${CONTAINERS:-proget-server proget-database}"

CONF_DIR=/etc/zabbix
DROPIN_DIR=$CONF_DIR/zabbix_agentd.d
SCRIPTS_DIR=/etc/zabbix/scripts
UNIT=zabbix-agent

say()  { echo "[INFO] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }
run()  { if [ -n "${DRY_RUN:-}" ]; then echo "[DRY] $*"; else "$@"; fi; }

[ -n "$ZBX_SERVER" ] || fail "задайте ZBX_SERVER=<IP zabbix-сервера>"
case "$ZBX_SERVER" in
    *[A-Za-z]*) fail "ZBX_SERVER должен быть IP, не имя: $ZBX_SERVER
       Статический агент падает на DNS (см. шапку скрипта)." ;;
esac
[ "$(id -u)" = "0" ] || [ -n "${DRY_RUN:-}" ] || fail "запускать под root"

# --- 1. Что уже стоит --------------------------------------------------------

existing=""
if command -v zabbix_agent2 >/dev/null 2>&1 || [ -x /usr/sbin/zabbix_agent2 ]; then
    existing="agent2"
    DROPIN_DIR=$CONF_DIR/zabbix_agent2.d
    UNIT=zabbix-agent2
elif command -v zabbix_agentd >/dev/null 2>&1 || [ -x /usr/sbin/zabbix_agentd ]; then
    existing="agentd"
fi

say "zabbix server : $ZBX_SERVER"
say "hostname      : $ZBX_HOSTNAME"
say "proget        : $PROGET_URL  (внешнее имя $PROGET_FQDN)"
say "контейнеры    : $CONTAINERS"
if [ -n "$existing" ]; then
    say "агент уже есть: $existing, переставлять не буду, только конфиг"
else
    say "агента нет, ставлю статический zabbix_agentd из тарбола"
    [ -n "$AGENT_TGZ" ] || fail "агента нет и AGENT_TGZ не задан. Скачайте
       zabbix_agent-5.0.46-linux-3.0-amd64-static.tar.gz с cdn.zabbix.com
       (или положите в ProGet asset-feed) и передайте путь в AGENT_TGZ."
    [ -f "$AGENT_TGZ" ] || fail "нет файла $AGENT_TGZ"
fi

# --- 2. Установка статика, если нужно ----------------------------------------

if [ -z "$existing" ]; then
    tmp=$(mktemp -d)
    run tar xzf "$AGENT_TGZ" -C "$tmp"
    [ -n "${DRY_RUN:-}" ] || [ -x "$tmp/sbin/zabbix_agentd" ] || fail "в тарболе нет sbin/zabbix_agentd"

    run install -m 0755 "$tmp/sbin/zabbix_agentd" /usr/sbin/zabbix_agentd
    run install -m 0755 "$tmp/bin/zabbix_get"     /usr/bin/zabbix_get
    run install -m 0755 "$tmp/bin/zabbix_sender"  /usr/bin/zabbix_sender
    rm -rf "$tmp"

    if ! id zabbix >/dev/null 2>&1; then
        run useradd --system --home /var/lib/zabbix --shell /usr/sbin/nologin zabbix
    fi
    run install -d -o zabbix -g zabbix -m 0755 /var/lib/zabbix /var/log/zabbix /run/zabbix
    run install -d -m 0755 "$CONF_DIR" "$DROPIN_DIR"

    if [ -n "${DRY_RUN:-}" ]; then
        echo "[DRY] записать $CONF_DIR/zabbix_agentd.conf"
    else
        cat > "$CONF_DIR/zabbix_agentd.conf" <<EOF
# Сгенерировано 70-proget-zabbix-agent.sh. Локальные правки класть в
# $DROPIN_DIR/*.conf, этот файл перезаписывается.
PidFile=/run/zabbix/zabbix_agentd.pid
LogFile=/var/log/zabbix/zabbix_agentd.log
LogFileSize=10
# 127.0.0.1 нужен для самопроверки zabbix_get с самого хоста.
Server=127.0.0.1,$ZBX_SERVER
ServerActive=$ZBX_SERVER
Hostname=$ZBX_HOSTNAME
Timeout=10
Include=$DROPIN_DIR/*.conf
EOF
    fi

    if [ -n "${DRY_RUN:-}" ]; then
        echo "[DRY] записать /etc/systemd/system/zabbix-agent.service"
    else
        cat > /etc/systemd/system/zabbix-agent.service <<'EOF'
[Unit]
Description=Zabbix Agent (static build)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=forking
User=zabbix
Group=zabbix
RuntimeDirectory=zabbix
PIDFile=/run/zabbix/zabbix_agentd.pid
ExecStart=/usr/sbin/zabbix_agentd -c /etc/zabbix/zabbix_agentd.conf
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    fi
    run systemctl daemon-reload
fi

# --- 3. Конфиг под ProGet -----------------------------------------------------

run install -d -m 0755 "$DROPIN_DIR" "$SCRIPTS_DIR"

# Скрипт проверки: /health отдаёт JSON, вытаскиваем поле. Без jq, чтобы не
# тянуть зависимости на хост: sed по простому плоскому JSON ProGet хватает.
if [ -n "${DRY_RUN:-}" ]; then
    echo "[DRY] записать $SCRIPTS_DIR/proget_health.sh"
else
    cat > "$SCRIPTS_DIR/proget_health.sh" <<EOF
#!/bin/sh
# proget_health.sh <поле|raw|rtt>
# Поля /health у ProGet 2026: applicationName, databaseStatus, extensionsInstalled,
# licenseStatus, serviceStatus, versionNumber, releaseNumber.
url="$PROGET_URL/health"
case "\${1:-raw}" in
    rtt)
        curl -s -o /dev/null --noproxy '*' -m 8 -w '%{time_total}' "\$url" 2>/dev/null || echo 0
        ;;
    raw)
        curl -s --noproxy '*' -m 8 "\$url" 2>/dev/null || echo '{}'
        ;;
    *)
        body=\$(curl -s --noproxy '*' -m 8 "\$url" 2>/dev/null) || body='{}'
        # значение может быть строкой ("OK") либо null/числом
        val=\$(printf '%s' "\$body" | sed -n "s/.*\"\$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p")
        [ -n "\$val" ] || val=\$(printf '%s' "\$body" | sed -n "s/.*\"\$1\"[[:space:]]*:[[:space:]]*\\([^,}]*\\).*/\\1/p")
        printf '%s\n' "\${val:-UNKNOWN}"
        ;;
esac
EOF
    chmod 0755 "$SCRIPTS_DIR/proget_health.sh"
fi

if [ -n "${DRY_RUN:-}" ]; then
    echo "[DRY] записать $SCRIPTS_DIR/proget_containers_lld.sh"
else
    cat > "$SCRIPTS_DIR/proget_containers_lld.sh" <<EOF
#!/bin/sh
# LLD-JSON для правила "ProGet containers". Список зашит при установке:
# имена контейнеров задаёт docker-compose и они не меняются.
first=1
printf '{"data":['
for c in $CONTAINERS; do
    [ \$first = 1 ] || printf ','
    printf '{"{#NAME}":"%s"}' "\$c"
    first=0
done
printf ']}\n'
EOF
    chmod 0755 "$SCRIPTS_DIR/proget_containers_lld.sh"
fi

if [ -n "${DRY_RUN:-}" ]; then
    echo "[DRY] записать $SCRIPTS_DIR/cert_days.sh"
else
    cat > "$SCRIPTS_DIR/cert_days.sh" <<'EOF'
#!/bin/sh
# cert_days.sh <host> [port] — сколько дней до конца сертификата. -1 если не прочитался.
host="$1"; port="${2:-443}"
# timeout: если 443 фильтруется, s_client висит до Timeout агента и item
# уходит в NOTSUPPORTED вместо честного -1.
end=$(echo | timeout 5 openssl s_client -servername "$host" -connect "$host:$port" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
[ -n "$end" ] || { echo -1; exit 0; }
end_s=$(date -d "$end" +%s 2>/dev/null) || { echo -1; exit 0; }
echo $(( (end_s - $(date +%s)) / 86400 ))
EOF
    chmod 0755 "$SCRIPTS_DIR/cert_days.sh"
fi

if [ -n "${DRY_RUN:-}" ]; then
    echo "[DRY] записать $DROPIN_DIR/proget.conf"
else
    cat > "$DROPIN_DIR/proget.conf" <<EOF
# ProGet: ключи для шаблона "ProGet by Zabbix agent". Сгенерировано
# 70-proget-zabbix-agent.sh.

# /health целиком и по полям: proget.health[databaseStatus] и т.д.
UserParameter=proget.health.raw,$SCRIPTS_DIR/proget_health.sh raw
UserParameter=proget.health.rtt,$SCRIPTS_DIR/proget_health.sh rtt
UserParameter=proget.health[*],$SCRIPTS_DIR/proget_health.sh \$1

# LLD: список контейнеров для правила обнаружения в шаблоне.
UserParameter=proget.containers.discovery,$SCRIPTS_DIR/proget_containers_lld.sh

# Контейнеры: running/exited/missing и число рестартов.
UserParameter=proget.container.state[*],docker inspect -f '{{.State.Status}}' \$1 2>/dev/null || echo missing
UserParameter=proget.container.restarts[*],docker inspect -f '{{.RestartCount}}' \$1 2>/dev/null || echo -1
UserParameter=proget.container.health[*],docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \$1 2>/dev/null || echo missing

# Сертификат внешнего имени, дней до конца.
UserParameter=proget.cert.days,$SCRIPTS_DIR/cert_days.sh $PROGET_FQDN 443

# Данные ProGet: занято байт (для тренда), помимо штатного vfs.fs.size.
UserParameter=proget.data.bytes,du -sb $PROGET_DATA 2>/dev/null | cut -f1
EOF
fi

# docker inspect нужен доступ к сокету: группа docker.
if getent group docker >/dev/null 2>&1; then
    run usermod -aG docker zabbix
else
    say "группы docker нет, проверки контейнеров работать не будут"
fi

# --- 4. Запуск и самопроверка -------------------------------------------------

run systemctl enable "$UNIT"
run systemctl restart "$UNIT"

if [ -z "${DRY_RUN:-}" ]; then
    sleep 2
    systemctl is-active --quiet "$UNIT" || fail "$UNIT не поднялся, см. journalctl -u $UNIT"
    say "самопроверка через zabbix_get:"
    for key in agent.ping "proget.health[serviceStatus]" "proget.health[databaseStatus]" \
               "proget.health[licenseStatus]" "proget.health[versionNumber]" proget.health.rtt \
               $(for c in $CONTAINERS; do echo "proget.container.state[$c]"; done) \
               proget.containers.discovery proget.cert.days proget.data.bytes; do
        printf '  %-40s ' "$key"
        zabbix_get -s 127.0.0.1 -k "$key" 2>&1 | head -1 || true
    done
fi

echo
say "готово. Дальше на сервере Zabbix:"
echo "  1. Импортировать шаблон zabbix/proget-by-agent-5.0.xml (Configuration > Templates > Import)."
echo "  2. Создать хост '$ZBX_HOSTNAME', интерфейс agent на IP этого хоста, порт 10050."
echo "  3. Привязать шаблоны: 'ProGet by Zabbix agent', 'Template OS Linux by Zabbix agent'."
echo "  4. В макросах хоста при необходимости: {\$PROGET.CONTAINERS} = $CONTAINERS"
