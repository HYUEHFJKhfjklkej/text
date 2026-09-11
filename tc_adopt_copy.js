/*
 * tc_adopt_copy.js — сделать из пустых проектов TeamCity полноценные копии
 * EL_CONF. Запускается в консоли браузера (F12) на странице TeamCity, поэтому
 * идёт под вашей сессией: ни пароль, ни токен не нужны.
 *
 * Это тот же алгоритм, что в teamcity_iac.py, один в один:
 *   1. найти донора EL_CONF внутри SURA2/COMPONENTS/CMAKE;
 *   2. для каждого репозитория из списка найти проект с таким именем;
 *   3. если он есть и ПУСТ (нет конфигураций, подпроектов, своих VCS-корней),
 *      удалить его и создать заново копией донора, с явным id;
 *   4. выставить имя и параметры repoProject, repoName, projectName.
 *
 * Копирование идёт XML-формой newProjectDescription: именно её принимает
 * TeamCity 2018.1. JSON-вариант там не работает, на этом уже обжигались.
 *
 * Как запускать:
 *   1. Открыть TeamCity, F12, вкладка Console, вставить, Enter.
 *   2. Смотреть таблицу. Строки должны быть ADOPT или CREATE.
 *      NOT_EMPTY значит, что в проекте уже что-то есть: скрипт его не тронет.
 *   3. Поменять APPLY на true, вставить и запустить ещё раз.
 */
(async () => {

  // ---------------------------------------------------------------- НАСТРОЙКИ

  var APPLY = false;

  // Имена репозиториев в нижнем регистре. Проект в TeamCity ищется по имени
  // заглавными, создаётся тоже заглавными.
  var REPOSITORIES = [
    "device_config_manager",
    "elecont_protocol_client",
    "file_factory"
  ];

  // Донор и область, где искать и его, и цели. В дереве несколько EL_CONF и
  // несколько CMAKE (SURA2 и SURA2G1), поэтому без области нельзя.
  var SCOPE_ID = "Sura2_Components_Cmake";
  var DONOR = "EL_CONF";

  // Параметры, которые выставляются каждому новому проекту.
  // "@repo" заменяется на имя репозитория.
  var PARAMS = {
    "repoProject": "su2",
    "repoName": "@repo",
    "projectName": "@repo",
    "iac.managedBy": "text/tc_adopt_copy.js"
  };

  // ------------------------------------------------------------------- ОБЩЕЕ

  if (location.host.indexOf("teamcity") === -1
      && document.title.indexOf("TeamCity") === -1) {
    console.error("ОШИБКА: откройте TeamCity.");
    return;
  }

  var api = location.origin + "/app/rest/2018.1";
  var csrf = "";

  try {
    var c = await fetch(location.origin + "/authenticationTest.html?csrf",
                        { credentials: "same-origin" });
    if (c.ok) csrf = (await c.text()).trim();
  } catch (e) {
    csrf = "";
  }
  if (csrf.indexOf("<") !== -1 || csrf.length > 100) csrf = "";
  console.log(csrf ? "CSRF-токен получен." : "CSRF-токен не нужен или недоступен.");

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

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Id проекта как в teamcity_iac.py: родитель + "_" + CamelCase имени.
  function idSegment(name) {
    var words = name.match(/[A-Za-z0-9]+/g) || [];
    var out = "";
    for (var i = 0; i < words.length; i++) {
      out += words[i].charAt(0).toUpperCase() + words[i].slice(1);
    }
    return out;
  }

  console.log("Режим: " + (APPLY ? "ПРИМЕНЕНИЕ" : "DRY RUN"));

  var listUrl = api + "/projects?locator=count:10000"
              + "&fields=project(id,name,parentProjectId,description)";
  var all = (await (await req(listUrl)).json()).project || [];

  var byId = {};
  for (var i0 = 0; i0 < all.length; i0++) byId[all[i0].id] = all[i0];

  function pathOf(p) {
    var parts = [];
    var cur = p;
    var guard = 0;
    while (cur && guard < 20) {
      parts.unshift(cur.name);
      cur = byId[cur.parentProjectId];
      guard++;
    }
    return parts.join("/");
  }

  function inScope(p) {
    var cur = p;
    var guard = 0;
    while (cur && guard < 20) {
      if (cur.id === SCOPE_ID) return true;
      cur = byId[cur.parentProjectId];
      guard++;
    }
    return false;
  }

  if (!byId[SCOPE_ID]) {
    console.error("ОШИБКА: SCOPE_ID " + SCOPE_ID + " в дереве не найден.");
    return;
  }
  console.log("Область: " + pathOf(byId[SCOPE_ID]) + " (" + SCOPE_ID + ")");

  function findByName(name) {
    var hits = [];
    var low = (name || "").toLowerCase();
    for (var i = 0; i < all.length; i++) {
      if ((all[i].name || "").toLowerCase() === low && inScope(all[i])) {
        hits.push(all[i]);
      }
    }
    return hits;
  }

  var donors = findByName(DONOR);
  if (donors.length !== 1) {
    console.error("ОШИБКА: донор " + DONOR + " найден " + donors.length + " раз.");
    for (var d = 0; d < donors.length; d++) {
      console.error("  " + donors[d].id + "   " + pathOf(donors[d]));
    }
    return;
  }
  var donor = donors[0];
  var parentId = donor.parentProjectId;
  console.log("Донор: " + pathOf(donor) + " (" + donor.id + ")");
  console.log("Родитель для новых: " + pathOf(byId[parentId]) + " (" + parentId + ")");

  async function detail(id) {
    var url = api + "/projects/id:" + encodeURIComponent(id)
            + "?fields=id,name,buildTypes(count),projects(count),vcsRoots(count)";
    return await (await req(url)).json();
  }

  function isEmpty(det) {
    var keys = ["buildTypes", "projects", "vcsRoots"];
    for (var i = 0; i < keys.length; i++) {
      var block = det[keys[i]] || {};
      if (parseInt(block.count || 0, 10) > 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------- ПЛАН

  var plan = [];
  for (var r = 0; r < REPOSITORIES.length; r++) {
    var repo = REPOSITORIES[r];
    var wantId = parentId + "_" + idSegment(repo);
    var hits = findByName(repo);
    var row = { repo: repo, project: repo.toUpperCase(), id: wantId,
                existing: "", state: "" };

    if (hits.length > 1) {
      row.state = "AMBIGUOUS";
      for (var h = 0; h < hits.length; h++) {
        console.error("  " + hits[h].id + "   " + pathOf(hits[h]));
      }
    } else if (hits.length === 0) {
      row.state = "CREATE";
    } else {
      var ex = hits[0];
      row.existing = ex.id;
      var desc = ex.description || "";
      if (desc.indexOf("Managed by") === 0) {
        row.state = "MANAGED";
      } else {
        var det = await detail(ex.id);
        row.state = isEmpty(det) ? "ADOPT" : "NOT_EMPTY";
      }
    }
    plan.push(row);
  }

  console.table(plan);

  var bad = [];
  for (var b = 0; b < plan.length; b++) {
    if (plan[b].state === "AMBIGUOUS" || plan[b].state === "NOT_EMPTY") {
      bad.push(plan[b].repo + "=" + plan[b].state);
    }
  }
  if (bad.length) {
    console.error("ОСТАНОВ: " + bad.join(", ") + ". Ничего не изменено.");
    console.error("NOT_EMPTY: в проекте уже есть конфигурации, подпроекты или");
    console.error("VCS-корни. Сносить такое скрипт не станет, разберитесь руками.");
    return;
  }

  if (!APPLY) {
    console.log("DRY RUN: ничего не изменено. Поставьте APPLY = true.");
    console.log("ADOPT: пустой проект будет удалён и создан заново копией донора.");
    console.log("MANAGED: уже наша копия, только обновятся параметры.");
    return;
  }

  // ---------------------------------------------------------------- APPLY

  for (var a = 0; a < plan.length; a++) {
    var it = plan[a];
    console.log("--- " + it.project + " ---");

    if (it.state === "ADOPT") {
      await req(api + "/projects/id:" + encodeURIComponent(it.existing), {
        method: "DELETE",
        headers: { Accept: "text/plain" }
      });
      console.log("  удалён пустой " + it.existing);
      it.state = "CREATE";
    }

    if (it.state === "CREATE") {
      var xml = '<?xml version="1.0" encoding="utf-8"?>'
        + '<newProjectDescription copyAllAssociatedSettings="true"'
        + ' id="' + xmlEscape(it.id) + '"'
        + ' name="' + xmlEscape(it.project) + '"'
        + ' description="Managed by text/tc_adopt_copy.js; source: '
        + xmlEscape(pathOf(donor)) + '">'
        + '<sourceProject locator="id:' + xmlEscape(donor.id) + '"/>'
        + '<parentProject locator="id:' + xmlEscape(parentId) + '"/>'
        + '</newProjectDescription>';
      await req(api + "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml
      });
      console.log("  скопирован из " + donor.name + " как " + it.id);
    }

    var pid = it.state === "MANAGED" ? it.existing : it.id;

    await req(api + "/projects/id:" + encodeURIComponent(pid) + "/name", {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "text/plain" },
      body: it.project
    });

    var have = {};
    var pr = await (await req(api + "/projects/id:" + encodeURIComponent(pid)
                              + "/parameters?fields=property(name)")).json();
    var props = pr.property || [];
    for (var q = 0; q < props.length; q++) have[props[q].name] = true;

    for (var key in PARAMS) {
      var value = PARAMS[key] === "@repo" ? it.repo : PARAMS[key];
      var base = api + "/projects/id:" + encodeURIComponent(pid) + "/parameters";
      if (have[key]) {
        await req(base + "/" + encodeURIComponent(key), {
          method: "PUT",
          headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "text/plain" },
          body: value
        });
      } else {
        await req(base, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: '<?xml version="1.0" encoding="utf-8"?><property name="'
              + xmlEscape(key) + '" value="' + xmlEscape(value) + '"/>'
        });
      }
      console.log("  параметр " + key + " = " + value);
    }
  }

  console.log("");
  console.log("ГОТОВО. Обновите дерево проектов и проверьте " + REPOSITORIES.length
              + " проекта: внутри должны быть Windows, Linux, CN900, CN910.");

})().catch(function (e) { console.error("ОШИБКА:", e); });
