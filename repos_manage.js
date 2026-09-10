/*
 * repos_manage.js — переименование и создание репозиториев в Bitbucket и
 * проектов в TeamCity. Один скрипт на оба сайта: что делать, определяется по
 * адресу открытой страницы.
 *
 * Заявка Неплюева от 10.09.2026:
 *   переименовать: gui_sdk -> el_grpc_interfaces
 *   создать:       device_config_manager, elecont_protocol_client, file_factory
 *
 * Как запускать:
 *   1. Открыть Bitbucket (или TeamCity) под своей учётной записью.
 *   2. F12, вкладка Console, вставить весь скрипт, Enter.
 *   3. Посмотреть таблицу плана. Все строки должны быть READY.
 *   4. Поменять APPLY на true, вставить и запустить ещё раз.
 *
 * Грабли, на которых уже обжигались:
 *   - в TeamCity имена проектов ЗАГЛАВНЫМИ, скрипт приводит сам;
 *   - TeamCity без Accept: application/json отдаёт XML, и JSON.parse падает
 *     на "Unexpected token '<'";
 *   - эндпойнт PUT /name отвечает только text/plain, иначе 406 Not Acceptable;
 *   - вставка в консоль рвёт длинные строки, поэтому здесь нет ни шаблонных
 *     строк, ни вложенных тернарников.
 */
(async () => {

  // ---------------------------------------------------------------- НАСТРОЙКИ

  var APPLY = false;

  // Переименования. Слева текущее имя, справа новое.
  var RENAMES = [
    ["gui_sdk", "el_grpc_interfaces"]
  ];

  // Создание. Имена в нижнем регистре, TeamCity получит их заглавными.
  var CREATES = [
    "device_config_manager",
    "elecont_protocol_client",
    "file_factory"
  ];

  // Bitbucket: ключ проекта, внутри которого лежат репозитории.
  // Виден в адресе страницы проекта: /projects/<КЛЮЧ>/
  var BITBUCKET_PROJECT = "SU2";

  // TeamCity: путь до родительского проекта, по именам, сверху вниз.
  var TC_PARENT_PATH = ["SURA2", "COMPONENTS", "CMAKE", "EL_CONF"];

  // ------------------------------------------------------------------- ОБЩЕЕ

  var host = location.host;
  var isBitbucket = location.pathname.indexOf("/projects/") === 0
                 || location.pathname.indexOf("/scm/") === 0
                 || host.indexOf("bitbucket") !== -1;
  var isTeamCity = host.indexOf("teamcity") !== -1
                || location.pathname.indexOf("/app/rest") === 0
                || document.title.indexOf("TeamCity") !== -1;

  if (isBitbucket && isTeamCity) isTeamCity = false;

  if (!isBitbucket && !isTeamCity) {
    console.error("ОШИБКА: не понял, что это за сайт. Откройте Bitbucket или TeamCity.");
    return;
  }

  console.log("Сайт: " + (isBitbucket ? "Bitbucket" : "TeamCity") + " (" + host + ")");
  console.log("Режим: " + (APPLY ? "ПРИМЕНЕНИЕ" : "DRY RUN"));

  var csrf = "";

  async function req(url, opts) {
    opts = opts || {};
    var headers = { Accept: "application/json" };
    if (opts.headers) {
      for (var k in opts.headers) headers[k] = opts.headers[k];
    }
    if (csrf) headers["X-TC-CSRF-Token"] = csrf;
    var init = { credentials: "same-origin", headers: headers };
    for (var o in opts) {
      if (o !== "headers") init[o] = opts[o];
    }
    var r = await fetch(url, init);
    if (!r.ok) {
      var body = "";
      try { body = await r.text(); } catch (e) { body = ""; }
      throw new Error(r.status + " " + r.statusText + " " + url + " " + body.slice(0, 300));
    }
    return r;
  }

  function report(plan) {
    console.table(plan);
    var bad = [];
    for (var i = 0; i < plan.length; i++) {
      if (plan[i].state !== "READY") bad.push(plan[i].state);
    }
    if (bad.length) {
      console.error("ОСТАНОВ: не все строки READY (" + bad.join(", ") + "). Ничего не изменено.");
      return false;
    }
    if (!APPLY) {
      console.log("DRY RUN: ничего не изменено. Поставьте APPLY = true.");
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------- BITBUCKET

  async function runBitbucket() {
    var api = location.origin + "/rest/api/1.0/projects/" + BITBUCKET_PROJECT;

    var repos = [];
    var start = 0;
    for (;;) {
      var page = await (await req(api + "/repos?limit=1000&start=" + start)).json();
      repos = repos.concat(page.values || []);
      if (page.isLastPage !== false) break;
      start = page.nextPageStart;
    }
    console.log("Репозиториев в проекте " + BITBUCKET_PROJECT + ": " + repos.length);

    var bySlug = {};
    for (var i = 0; i < repos.length; i++) {
      bySlug[(repos[i].slug || "").toLowerCase()] = repos[i];
      bySlug[(repos[i].name || "").toLowerCase()] = repos[i];
    }

    var plan = [];
    for (var r = 0; r < RENAMES.length; r++) {
      var from = RENAMES[r][0];
      var to = RENAMES[r][1];
      var src = bySlug[from];
      var dst = bySlug[to];
      var state = "MISSING";
      if (src && dst) state = "CONFLICT";
      else if (src) state = "READY";
      plan.push({ action: "RENAME", from: from, to: to, state: state });
    }
    for (var c = 0; c < CREATES.length; c++) {
      var name = CREATES[c];
      plan.push({
        action: "CREATE",
        from: "",
        to: name,
        state: bySlug[name] ? "EXISTS" : "READY"
      });
    }

    if (!report(plan)) return;

    for (var r2 = 0; r2 < RENAMES.length; r2++) {
      var f = RENAMES[r2][0];
      var t = RENAMES[r2][1];
      var repo = bySlug[f];
      await req(api + "/repos/" + encodeURIComponent(repo.slug), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: t })
      });
      console.log("RENAMED: " + f + " -> " + t);
    }

    for (var c2 = 0; c2 < CREATES.length; c2++) {
      var n = CREATES[c2];
      await req(api + "/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, scmId: "git", forkable: true })
      });
      console.log("CREATED: " + n);
    }

    console.log("ГОТОВО: Bitbucket обработан.");
  }

  // --------------------------------------------------------------- TEAMCITY

  async function runTeamCity() {
    var api = location.origin + "/app/rest";

    try {
      var c = await fetch(location.origin + "/authenticationTest.html?csrf",
                          { credentials: "same-origin" });
      if (c.ok) csrf = (await c.text()).trim();
    } catch (e) {
      csrf = "";
    }
    if (csrf.indexOf("<") !== -1 || csrf.length > 100) csrf = "";
    console.log(csrf ? "CSRF-токен получен." : "CSRF-токен не нужен или недоступен.");

    var all = (await (await req(api + "/projects")).json()).project || [];

    var byId = {};
    for (var i = 0; i < all.length; i++) byId[all[i].id] = all[i];

    function pathOf(p) {
      var parts = [];
      var cur = p;
      var guard = 0;
      while (cur && guard < 20) {
        parts.unshift(cur.name);
        cur = byId[cur.parentProjectId];
        guard++;
      }
      return parts;
    }

    var wanted = TC_PARENT_PATH.join("/").toLowerCase();
    var parents = [];
    for (var j = 0; j < all.length; j++) {
      var full = pathOf(all[j]).join("/").toLowerCase();
      var last = TC_PARENT_PATH[TC_PARENT_PATH.length - 1].toLowerCase();
      if (full.indexOf(wanted) !== -1 && full.split("/").pop() === last) {
        parents.push(all[j]);
      }
    }
    if (parents.length !== 1) {
      console.error("ОШИБКА: родительский путь " + TC_PARENT_PATH.join("/")
                    + " найден " + parents.length + " раз. Поправьте TC_PARENT_PATH.");
      return;
    }
    var parentId = parents[0].id;
    console.log("Родительский проект: " + parents[0].name + " (" + parentId + ")");

    var children = [];
    for (var k = 0; k < all.length; k++) {
      if (all[k].parentProjectId === parentId) children.push(all[k]);
    }
    var byName = {};
    for (var m = 0; m < children.length; m++) {
      byName[(children[m].name || "").toLowerCase()] = children[m];
    }

    var plan = [];
    for (var r = 0; r < RENAMES.length; r++) {
      var from = RENAMES[r][0];
      var to = RENAMES[r][1];
      var src = byName[from];
      var dst = byName[to];
      var state = "MISSING";
      if (src && dst && src.id !== dst.id) state = "CONFLICT";
      else if (src) state = "READY";
      plan.push({
        action: "RENAME",
        from: from,
        to: to.toUpperCase(),
        id: src ? src.id : "",
        state: state
      });
    }
    for (var c = 0; c < CREATES.length; c++) {
      var name = CREATES[c];
      plan.push({
        action: "CREATE",
        from: "",
        to: name.toUpperCase(),
        id: "",
        state: byName[name] ? "EXISTS" : "READY"
      });
    }

    if (!report(plan)) return;

    for (var r2 = 0; r2 < RENAMES.length; r2++) {
      var f = RENAMES[r2][0];
      var t = RENAMES[r2][1].toUpperCase();
      var p = byName[f];
      await req(api + "/projects/id:" + encodeURIComponent(p.id) + "/name", {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "text/plain" },
        body: t
      });
      console.log("RENAMED: " + f + " -> " + t);
    }

    for (var c2 = 0; c2 < CREATES.length; c2++) {
      var n = CREATES[c2].toUpperCase();
      await req(api + "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: n,
          parentProject: { locator: "id:" + parentId }
        })
      });
      console.log("CREATED: " + n);
    }

    console.log("ГОТОВО: TeamCity обработан.");
  }

  if (isBitbucket) await runBitbucket();
  else await runTeamCity();

})().catch(function (e) { console.error("ОШИБКА:", e); });
