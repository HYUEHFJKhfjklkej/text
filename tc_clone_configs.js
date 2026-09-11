/*
 * tc_clone_configs.js — перенести структуру сборок с проекта-донора в пустые
 * проекты TeamCity.
 *
 * Зачем: repos_manage.js создаёт проекты пустыми, и TeamCity пишет в них
 * "No build configurations". У соседей вроде EL_CONF внутри лежат
 * CN900 PACKAGE, CN910 RELEASE и подпроекты Windows и Linux. Скрипт копирует
 * ровно это.
 *
 * Копирование идёт штатным REST TeamCity: sourceProject для подпроектов и
 * sourceBuildType для конфигураций. Ничего не удаляется, существующая
 * структура не трогается.
 *
 * Как запускать:
 *   1. Открыть TeamCity под своей учётной записью, F12, Console.
 *   2. MODE = "inspect" — посмотреть, что внутри донора. Ничего не меняет.
 *   3. MODE = "plan"    — что будет сделано. Ничего не меняет.
 *   4. MODE = "apply"   — выполнить.
 *
 * Обязательно пройдите inspect. Донор тянет за собой VCS-корни, триггеры и
 * параметры, и лучше увидеть это заранее, чем разбирать потом.
 */
(async () => {

  // ---------------------------------------------------------------- НАСТРОЙКИ

  var MODE = "inspect";   // inspect | plan | apply

  // Область поиска: работаем только внутри этого проекта и его потомков.
  // Нужна потому, что в дереве есть и SURA2, и SURA2G1, и одинаковые имена
  // встречаются по нескольку раз. Id виден в адресе, ...&projectId=<ID>
  var SCOPE_ID = "Sura2_Components_Cmake";

  // Проект, с которого копируем. Имя как в дереве, поиск внутри SCOPE_ID.
  var DONOR = "EL_CONF";

  // Если имя всё равно неоднозначно, задайте id донора напрямую.
  var DONOR_ID = "";

  // Проекты, в которые копируем. Должны существовать и быть пустыми.
  var TARGETS = [
    "DEVICE_CONFIG_MANAGER",
    "ELECONT_PROTOCOL_CLIENT",
    "FILE_FACTORY"
  ];

  // Параметры проекта, которые надо поправить после копирования.
  // Имена подскажет режим inspect: он печатает параметры донора.
  // Значение "@lower" подставит имя проекта в нижнем регистре, "@name" как есть.
  // Пример: { "repoName": "@lower" }
  var PARAM_UPDATES = {};

  // ------------------------------------------------------------------- ОБЩЕЕ

  if (location.host.indexOf("teamcity") === -1
      && document.title.indexOf("TeamCity") === -1) {
    console.error("ОШИБКА: откройте TeamCity.");
    return;
  }

  var api = location.origin + "/app/rest";
  var csrf = "";

  try {
    var c = await fetch(location.origin + "/authenticationTest.html?csrf",
                        { credentials: "same-origin" });
    if (c.ok) csrf = (await c.text()).trim();
  } catch (e) {
    csrf = "";
  }
  if (csrf.indexOf("<") !== -1 || csrf.length > 100) csrf = "";

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

  async function projectInfo(id) {
    return await (await req(api + "/projects/id:" + encodeURIComponent(id))).json();
  }

  function names(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].name);
    return out.join(", ");
  }

  console.log("Режим: " + MODE);

  var all = (await (await req(api + "/projects")).json()).project || [];

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
    if (!SCOPE_ID) return true;
    var cur = p;
    var guard = 0;
    while (cur && guard < 20) {
      if (cur.id === SCOPE_ID) return true;
      cur = byId[cur.parentProjectId];
      guard++;
    }
    return false;
  }

  if (SCOPE_ID) {
    var scope = byId[SCOPE_ID];
    if (!scope) {
      console.error("ОШИБКА: SCOPE_ID " + SCOPE_ID + " в дереве не найден.");
      return;
    }
    console.log("Область поиска: " + pathOf(scope) + " (" + SCOPE_ID + ")");
  }

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

  function listCandidates(hits) {
    for (var q = 0; q < hits.length; q++) {
      console.error("  " + hits[q].id + "   " + pathOf(hits[q]));
    }
  }

  var donorId = DONOR_ID;
  if (!donorId) {
    var donors = findByName(DONOR);
    if (donors.length !== 1) {
      console.error("ОШИБКА: донор " + DONOR + " найден " + donors.length
                    + " раз. Сузьте SCOPE_ID либо задайте DONOR_ID.");
      listCandidates(donors);
      return;
    }
    donorId = donors[0].id;
  }
  var donor = await projectInfo(donorId);

  var donorSubs = (donor.projects && donor.projects.project) || [];
  var donorTypes = (donor.buildTypes && donor.buildTypes.buildType) || [];
  var donorParams = (donor.parameters && donor.parameters.property) || [];

  // ---------------------------------------------------------------- INSPECT

  if (MODE === "inspect") {
    console.log("Донор: " + pathOf(byId[donor.id] || donor) + " (" + donor.id + ")");
    console.log("");
    console.log("Подпроекты (" + donorSubs.length + "): " + (names(donorSubs) || "нет"));
    console.log("Конфигурации (" + donorTypes.length + "): " + (names(donorTypes) || "нет"));
    console.log("");
    console.log("Собственные параметры проекта:");
    if (!donorParams.length) {
      console.log("  нет");
    } else {
      var rows = [];
      for (var p = 0; p < donorParams.length; p++) {
        rows.push({
          name: donorParams[p].name,
          value: donorParams[p].value,
          inherited: donorParams[p].inherited ? "да" : ""
        });
      }
      console.table(rows);
      console.log("Параметры, которые ссылаются на имя репозитория или проекта,");
      console.log("после копирования придётся поправить. Впишите их в PARAM_UPDATES.");
    }
    console.log("");
    console.log("Дальше: MODE = \"plan\".");
    return;
  }

  // ------------------------------------------------------------------- ПЛАН

  var plan = [];
  var ready = [];

  for (var t = 0; t < TARGETS.length; t++) {
    var hits = findByName(TARGETS[t]);
    var row = { target: TARGETS[t], path: "", id: "", subprojects: "", buildTypes: "", state: "" };

    if (hits.length === 0) {
      row.state = "MISSING";
    } else if (hits.length > 1) {
      row.state = "AMBIGUOUS";
      console.error("Цель " + TARGETS[t] + " найдена " + hits.length + " раз:");
      listCandidates(hits);
    } else {
      row.path = pathOf(hits[0]);
      var info = await projectInfo(hits[0].id);
      var subs = (info.projects && info.projects.project) || [];
      var types = (info.buildTypes && info.buildTypes.buildType) || [];
      row.id = info.id;
      row.subprojects = subs.length;
      row.buildTypes = types.length;
      if (subs.length || types.length) {
        row.state = "NOT_EMPTY";
      } else {
        row.state = "READY";
        ready.push(info);
      }
    }
    plan.push(row);
  }

  console.log("Копируем из " + donor.name + ": подпроектов " + donorSubs.length
              + ", конфигураций " + donorTypes.length);
  console.table(plan);

  var bad = [];
  for (var i = 0; i < plan.length; i++) {
    if (plan[i].state !== "READY") bad.push(plan[i].target + "=" + plan[i].state);
  }
  if (bad.length) {
    console.error("ОСТАНОВ: " + bad.join(", ") + ". Ничего не изменено.");
    console.error("NOT_EMPTY значит, что в проекте уже что-то есть. Копировать");
    console.error("поверх скрипт не станет, разберитесь руками.");
    return;
  }

  if (MODE !== "apply") {
    console.log("PLAN: ничего не изменено. Поставьте MODE = \"apply\".");
    return;
  }

  // ---------------------------------------------------------------- APPLY

  for (var r = 0; r < ready.length; r++) {
    var target = ready[r];
    console.log("--- " + target.name + " ---");

    for (var s = 0; s < donorSubs.length; s++) {
      var sub = donorSubs[s];
      await req(api + "/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sub.name,
          sourceProject: { locator: "id:" + sub.id },
          parentProject: { locator: "id:" + target.id },
          copyAllAssociatedSettings: true
        })
      });
      console.log("  подпроект: " + sub.name);
    }

    for (var b = 0; b < donorTypes.length; b++) {
      var bt = donorTypes[b];
      await req(api + "/buildTypes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: bt.name,
          sourceBuildType: { locator: "id:" + bt.id },
          project: { locator: "id:" + target.id },
          copyAllAssociatedSettings: true
        })
      });
      console.log("  конфигурация: " + bt.name);
    }

    for (var key in PARAM_UPDATES) {
      var raw = PARAM_UPDATES[key];
      var value = raw;
      if (raw === "@lower") value = target.name.toLowerCase();
      if (raw === "@name") value = target.name;
      await req(api + "/projects/id:" + encodeURIComponent(target.id)
                + "/parameters/" + encodeURIComponent(key), {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "text/plain" },
        body: value
      });
      console.log("  параметр: " + key + " = " + value);
    }
  }

  console.log("");
  console.log("ГОТОВО. Проверьте в дереве, что структура совпадает с " + donor.name + ".");
  console.log("Триггеры и VCS-корни приехали копией донора: сверьте их до первого запуска.");

})().catch(function (e) { console.error("ОШИБКА:", e); });
