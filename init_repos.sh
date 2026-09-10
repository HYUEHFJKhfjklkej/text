#!/bin/bash
# init_repos.sh — инициализировать пустые репозитории Bitbucket ветками
# master и develop.
#
# Свежесозданный репозиторий пуст: в нём нет ни одного коммита, поэтому нет и
# веток. TeamCity такой репозиторий не сможет чекаутить, а Bitbucket не даст
# выставить default branch. Скрипт делает первый коммит, заводит обе ветки и
# отправляет их.
#
# Делается обычным git, а не REST: это ровно та операция, для которой git и
# нужен, и результат ничем не отличается от ручного `git push`.
#
# Запуск:
#   ./init_repos.sh                 показать план
#   APPLY=1 ./init_repos.sh         выполнить
#   REPOS="a b c" APPLY=1 ./init_repos.sh
#
# Env:
#   REPOS       список репозиториев через пробел
#   PROJECT     ключ проекта Bitbucket (по умолч. SU2)
#   BITBUCKET   базовый адрес (по умолч. http://bitbucket.inc.elara.local)
#   DEFAULT_BR  ветка по умолчанию в итоге (по умолч. develop)
#   README=1    положить README.md вместо пустого коммита
#   APPLY=1     выполнять, а не только показывать
#   WORK        рабочий каталог (по умолч. .init-repos)
#
# Учётные данные git берёт сам: спросит логин и пароль либо возьмёт из
# credential helper. Отдельный токен скрипту не нужен.
set -uo pipefail

REPOS="${REPOS:-device_config_manager elecont_protocol_client file_factory}"
PROJECT="${PROJECT:-SU2}"
BITBUCKET="${BITBUCKET:-http://bitbucket.inc.elara.local}"
DEFAULT_BR="${DEFAULT_BR:-develop}"
WORK="${WORK:-.init-repos}"

say()  { echo "[INFO] $*"; }
warn() { echo "[WARN] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git не найден"

echo "Bitbucket : $BITBUCKET"
echo "Проект    : $PROJECT"
echo "Репозитории: $REPOS"
echo "Ветки     : master, develop (по умолчанию будет $DEFAULT_BR)"
[ -z "${APPLY:-}" ] && echo "Режим     : ПОКАЗ, ничего не отправляется"
echo

rc=0
done_ok=0
skipped=0

for repo in $REPOS; do
    url="$BITBUCKET/scm/$PROJECT/$repo.git"
    echo "------------------------------------------------------------"
    echo "$repo"
    echo "  $url"

    # Уже с ветками? Тогда не трогаем: чужую историю переписывать нельзя.
    refs="$(git ls-remote --heads "$url" 2>&1)"
    if [ $? -ne 0 ]; then
        warn "недоступен: $(echo "$refs" | head -1)"
        rc=1
        continue
    fi
    if [ -n "$refs" ]; then
        say "ветки уже есть, пропускаю:"
        echo "$refs" | sed 's|^|      |'
        skipped=$((skipped + 1))
        continue
    fi
    say "пуст, нужна инициализация"

    if [ -z "${APPLY:-}" ]; then
        echo "      [ПЛАН] git init, коммит, push master, push develop"
        continue
    fi

    dir="$WORK/$repo"
    rm -rf "$dir"
    mkdir -p "$dir"

    (
        set -e
        cd "$dir"
        git init -q
        git checkout -q -b master

        if [ -n "${README:-}" ]; then
            printf '# %s\n' "$repo" > README.md
            git add README.md
            git -c user.name="${GIT_NAME:-ci}" \
                -c user.email="${GIT_EMAIL:-ci@elara.local}" \
                commit -q -m "init repo"
        else
            git -c user.name="${GIT_NAME:-ci}" \
                -c user.email="${GIT_EMAIL:-ci@elara.local}" \
                commit -q --allow-empty -m "init repo"
        fi

        git remote add origin "$url"
        git push -q origin master
        git checkout -q -b develop
        git push -q origin develop
    )

    if [ $? -eq 0 ]; then
        say "готово: master и develop отправлены"
        done_ok=$((done_ok + 1))
    else
        warn "не получилось, см. вывод выше"
        rc=1
    fi
done

echo "------------------------------------------------------------"
if [ -z "${APPLY:-}" ]; then
    echo "ПОКАЗ окончен. Для выполнения: APPLY=1 $0"
    exit "$rc"
fi

echo "Инициализировано: $done_ok, пропущено: $skipped"
echo
echo "Осталось руками, git этого не умеет:"
echo "  выставить ветку по умолчанию '$DEFAULT_BR' в каждом репозитории."
echo "  Bitbucket: Repository settings > Repository details > Default branch."
echo
echo "Проверка:"
for repo in $REPOS; do
    echo "  git ls-remote --heads $BITBUCKET/scm/$PROJECT/$repo.git"
done
exit "$rc"
