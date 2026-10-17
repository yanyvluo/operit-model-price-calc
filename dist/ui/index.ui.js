"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;

var PREFS_NAME = "toolpkg_price_calc";
var DATA_KEY = "price_calc_data_v1";

var DEFAULT_DATA = {
  groups: [],
  providers: [
    {
      id: "p_default",
      name: "基元律动",
      groupName: "",
      models: [
        { id: "m_default", name: "deepseek-flash", input: "", cached: "", cacheWrite: "", output: "", perRequest: "" }
      ]
    }
  ],
  active: { providerId: "p_default", modelId: "m_default" }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getContext() {
  try {
    if (typeof Java !== "undefined" && typeof Java.getApplicationContext === "function") {
      return Java.getApplicationContext();
    }
  } catch (e) {
    return null;
  }
  return null;
}

function getPrefs() {
  var context = getContext();
  if (!context) {
    return null;
  }
  try {
    return context.getSharedPreferences(PREFS_NAME, 0);
  } catch (e) {
    return null;
  }
}

function asStr(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

// 输入/缓存读取/输出："" 与 "0" 语义等价（都是 0 元），统一成 "" 让界面干净
function asPrice(value) {
  var s = asStr(value).trim();
  return s === "0" ? "" : s;
}

// ===== 从 Operit 软件配置同步中转站 / 模型 =====

// 手写 UTF-8 解码（宿主没有现成的）
function utf8Decode(bytes, start, end) {
  var s = "";
  for (var i = start; i < end; i += 1) {
    var b = bytes[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
    } else if (b >= 0xC0 && b < 0xE0) {
      s += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
      i += 1;
    } else if (b >= 0xE0 && b < 0xF0) {
      s += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F));
      i += 2;
    } else if (b >= 0xF0) {
      var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      cp -= 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      i += 3;
    }
  }
  return s;
}

// 读 datastore/model_configs.preferences_pb，解析出 [{name, models:[...]}]
function readOperitConfigs() {
  var result = { ok: false, configs: [], reason: "" };
  var ctx = getContext();
  if (!ctx) {
    result.reason = "no_context";
    return result;
  }
  try {
    var path = ctx.getFilesDir().getAbsolutePath() + "/datastore/model_configs.preferences_pb";
    var Runtime = Java.use("java.lang.Runtime");
    var proc = Runtime.getRuntime().exec("cat " + path);
    var is = proc.getInputStream();
    var bytes = [];
    var b;
    while ((b = is.read()) !== -1) {
      bytes.push(b & 0xFF);
    }
    proc.waitFor();
    is.close();

    // 扫描 "config_" (0x63 6f 6e 66 69 67 5f) 出现的位置
    var prefix = [0x63, 0x6F, 0x6E, 0x66, 0x69, 0x67, 0x5F];
    for (var i = 0; i < bytes.length - 7; i += 1) {
      var ok = true;
      for (var j = 0; j < 7; j += 1) {
        if (bytes[i + j] !== prefix[j]) { ok = false; break; }
      }
      if (!ok) {
        continue;
      }
      var st = i + 7;
      var idEnd = st;
      while (idEnd < bytes.length && bytes[idEnd] !== 0x2A) { idEnd += 1; }   // 到 '*'
      var id = utf8Decode(bytes, st, idEnd);
      if (id === "list") {
        continue;
      }
      var bs = idEnd;
      while (bs < bytes.length && bytes[bs] !== 0x7B) { bs += 1; }           // 到 '{'
      // 大括号配平提取 JSON
      var depth = 0, inStr = false, esc = false, endi = -1;
      for (var q = bs; q < bytes.length; q += 1) {
        var c = bytes[q];
        if (inStr) {
          if (esc) { esc = false; }
          else if (c === 0x5C) { esc = true; }
          else if (c === 0x22) { inStr = false; }
        } else {
          if (c === 0x22) { inStr = true; }
          else if (c === 0x7B) { depth += 1; }
          else if (c === 0x7D) { depth -= 1; if (depth === 0) { endi = q; break; } }
        }
      }
      if (endi > 0) {
        var js = utf8Decode(bytes, bs, endi + 1);
        try {
          var o = JSON.parse(js);
          var raw = asStr(o.modelName).split(",");
          var models = [];
          for (var m = 0; m < raw.length; m += 1) {
            var mn = asStr(raw[m]).replace(/^\s+|\s+$/g, "");
            if (mn) { models.push(mn); }
          }
          result.configs.push({ name: asStr(o.name), models: models });
        } catch (e) {
          // 跳过解析不了的块
        }
      }
    }
    result.ok = true;
  } catch (e) {
    result.reason = String(e);
  }
  return result;
}

// 把读到的配置合并进价格表（保留已有价格，只增不删）
function mergeConfigsIntoData(data, configs) {
  var next = clone(data);
  if (!Array.isArray(next.providers)) {
    next.providers = [];
  }
  var addedProviders = 0;
  var addedModels = 0;
  var seq = 1;
  function mkId(p) {
    return p + "_sync" + (new Date().getTime()).toString(36) + (seq++).toString(36);
  }
  function findProvider(name) {
    for (var i = 0; i < next.providers.length; i += 1) {
      if (asStr(next.providers[i].name) === name) {
        return next.providers[i];
      }
    }
    return null;
  }
  for (var c = 0; c < configs.length; c += 1) {
    var name = asStr(configs[c].name).replace(/^\s+|\s+$/g, "");
    if (!name) {
      continue;
    }
    var provider = findProvider(name);
    if (!provider) {
      provider = { id: mkId("p"), name: name, groupName: "", models: [] };
      next.providers.push(provider);
      addedProviders += 1;
    }
    if (provider.groupName === undefined || provider.groupName === null) {
      provider.groupName = "";
    }
    if (!Array.isArray(provider.models)) {
      provider.models = [];
    }
    var models = configs[c].models;
    for (var k = 0; k < models.length; k += 1) {
      var mn = models[k];
      var found = false;
      for (var x = 0; x < provider.models.length; x += 1) {
        if (asStr(provider.models[x].name) === mn) {
          found = true;
          break;
        }
      }
      if (!found) {
        provider.models.push({ id: mkId("m"), name: mn, input: "", cached: "", cacheWrite: "", output: "", perRequest: "" });
        addedModels += 1;
      }
    }
  }
  return { data: next, addedProviders: addedProviders, addedModels: addedModels };
}

function sanitize(input) {
  var src = (input && Array.isArray(input.providers)) ? input.providers : [];
  var providers = [];
  for (var i = 0; i < src.length; i += 1) {
    var p = src[i];
    if (!p) {
      continue;
    }
    var models = [];
    var modelSrc = Array.isArray(p.models) ? p.models : [];
    for (var j = 0; j < modelSrc.length; j += 1) {
      var m = modelSrc[j];
      if (!m) {
        continue;
      }
      models.push({
        id: asStr(m.id) || ("m_" + i + "_" + j),
        name: asStr(m.name),
        input: asPrice(m.input),
        cached: asPrice(m.cached),
        cacheWrite: asStr(m.cacheWrite),
        output: asPrice(m.output),
        perRequest: asPrice(m.perRequest)
      });
    }
    providers.push({
      id: asStr(p.id) || ("p_" + i),
      name: asStr(p.name),
      groupName: asStr(p.groupName),
      models: models
    });
  }
  var groups = [];
  var groupSrc = (input && Array.isArray(input.groups)) ? input.groups : [];
  for (var g = 0; g < groupSrc.length; g += 1) {
    var gn = asStr(groupSrc[g]);
    if (gn && groups.indexOf(gn) < 0) {
      groups.push(gn);
    }
  }
  // 兜底：providers 里出现的分组也补进来
  for (var pi = 0; pi < providers.length; pi += 1) {
    var pg = providers[pi].groupName;
    if (pg && groups.indexOf(pg) < 0) {
      groups.push(pg);
    }
  }
  var active = (input && input.active) ? input.active : {};
  return {
    groups: groups,
    providers: providers,
    active: {
      providerId: asStr(active.providerId),
      modelId: asStr(active.modelId)
    }
  };
}

function loadData() {
  var prefs = getPrefs();
  if (!prefs) {
    return clone(DEFAULT_DATA);
  }
  try {
    var raw = asStr(prefs.getString(DATA_KEY, "")).trim();
    if (!raw) {
      return clone(DEFAULT_DATA);
    }
    return sanitize(JSON.parse(raw));
  } catch (e) {
    return clone(DEFAULT_DATA);
  }
}

function persist(data) {
  var next = sanitize(data);
  var prefs = getPrefs();
  if (prefs) {
    try {
      prefs.edit().putString(DATA_KEY, JSON.stringify(next)).apply();
    } catch (e) {
      // ignore
    }
  }
  return next;
}

function describeActive(data) {
  var active = (data && data.active) ? data.active : {};
  var providers = (data && Array.isArray(data.providers)) ? data.providers : [];
  for (var i = 0; i < providers.length; i += 1) {
    if (providers[i].id === active.providerId) {
      var models = Array.isArray(providers[i].models) ? providers[i].models : [];
      for (var j = 0; j < models.length; j += 1) {
        if (models[j].id === active.modelId) {
          var m = models[j];
          var cwText = (m.cacheWrite === "" || m.cacheWrite === undefined || m.cacheWrite === null)
            ? "同输入价"
            : (m.cacheWrite === "0" ? "免费" : m.cacheWrite);
          return providers[i].name + " / " + (m.name || "(未命名)") +
            "  入 " + (m.input || "-") + " / 缓读 " + (m.cached || "-") +
            " / 缓写 " + cwText + " / 出 " + (m.output || "-") +
            (m.perRequest ? (" / 次 " + m.perRequest) : "");
        }
      }
    }
  }
  return "未设置";
}

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.floor(Math.random() * 100000).toString(36);
}

function Screen(ctx) {
  var dataState = ctx.useState("price_data", loadData());
  var data = dataState[0];
  var setData = dataState[1];

  var expState = ctx.useState("price_expanded", "");
  var expandedId = expState[0];
  var setExpandedId = expState[1];

  // 模型展开状态（默认折叠，只显示名字+价格概览）
  var mExpState = ctx.useState("price_model_expanded", "");
  var modelExpandedId = mExpState[0];
  var setModelExpandedId = mExpState[1];
  function toggleModel(id) {
    setModelExpandedId(modelExpandedId === id ? "" : id);
    setGpOpenId("");
  }

  var nameState = ctx.useState("price_new_provider", "");
  var newProviderName = nameState[0];
  var setNewProviderName = nameState[1];

  function commit(next) {
    setData(persist(next));
  }

  function idxProvider(list, id) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) {
        return i;
      }
    }
    return -1;
  }

  function idxModel(models, id) {
    for (var i = 0; i < models.length; i += 1) {
      if (models[i].id === id) {
        return i;
      }
    }
    return -1;
  }

  function toggleProvider(id) {
    setExpandedId(expandedId === id ? "" : id);
    setGpOpenId("");
    setModelExpandedId("");
  }

  function addProvider() {
    var name = asStr(newProviderName).trim();
    if (!name) {
      ctx.showToast("请先填写中转站名称");
      return;
    }
    var next = clone(data);
    next.providers.push({ id: genId("p"), name: name, models: [] });
    setNewProviderName("");
    commit(next);
  }

  function removeProvider(providerId) {
    var next = clone(data);
    var idx = idxProvider(next.providers, providerId);
    if (idx < 0) {
      return;
    }
    next.providers.splice(idx, 1);
    if (next.active.providerId === providerId) {
      next.active = { providerId: "", modelId: "" };
    }
    if (expandedId === providerId) {
      setExpandedId("");
    }
    commit(next);
  }

  function addModel(providerId) {
    var next = clone(data);
    var idx = idxProvider(next.providers, providerId);
    if (idx < 0) {
      return;
    }
    next.providers[idx].models.push({ id: genId("m"), name: "", input: "", cached: "", cacheWrite: "", output: "", perRequest: "" });
    commit(next);
  }

  function removeModel(providerId, modelId) {
    var next = clone(data);
    var pIdx = idxProvider(next.providers, providerId);
    if (pIdx < 0) {
      return;
    }
    var models = next.providers[pIdx].models;
    var mIdx = idxModel(models, modelId);
    if (mIdx < 0) {
      return;
    }
    models.splice(mIdx, 1);
    if (next.active.providerId === providerId && next.active.modelId === modelId) {
      next.active = { providerId: "", modelId: "" };
    }
    commit(next);
  }

  function patchModel(providerId, modelId, field, value) {
    var next = clone(data);
    var pIdx = idxProvider(next.providers, providerId);
    if (pIdx < 0) {
      return;
    }
    var models = next.providers[pIdx].models;
    var mIdx = idxModel(models, modelId);
    if (mIdx < 0) {
      return;
    }
    models[mIdx][field] = value;
    commit(next);
  }

  function patchProvider(providerId, field, value) {
    var next = clone(data);
    var pIdx = idxProvider(next.providers, providerId);
    if (pIdx < 0) {
      return;
    }
    next.providers[pIdx][field] = value;
    commit(next);
  }

  function setActive(providerId, modelId) {
    var next = clone(data);
    next.active = { providerId: providerId, modelId: modelId };
    commit(next);
    ctx.showToast("已切换当前生效价格");
  }

  function isActive(providerId, modelId) {
    return data.active.providerId === providerId && data.active.modelId === modelId;
  }

  // ===== 分组操作 =====
  var groupExpState = ctx.useState("price_group_expanded", "");
  var groupExpanded = groupExpState[0];
  var setGroupExpanded = groupExpState[1];

  var newGroupState = ctx.useState("price_new_group", "");
  var newGroupName = newGroupState[0];
  var setNewGroupName = newGroupState[1];

  var groupEditState = ctx.useState("price_group_edit", "");
  var groupEditId = groupEditState[0];
  var setGroupEditId = groupEditState[1];

  function groupList() {
    return Array.isArray(data.groups) ? data.groups : [];
  }

  function addGroup() {
    var name = asStr(newGroupName).trim();
    if (!name) {
      ctx.showToast("请先填写分组名称");
      return;
    }
    if (groupList().indexOf(name) >= 0) {
      ctx.showToast("该分组已存在");
      return;
    }
    var next = clone(data);
    if (!Array.isArray(next.groups)) { next.groups = []; }
    next.groups.push(name);
    setNewGroupName("");
    commit(next);
    ctx.showToast("已添加分组：" + name);
  }

  function removeGroup(name) {
    var next = clone(data);
    next.groups = (next.groups || []).filter(function (x) { return x !== name; });
    // 该分组下的中转站移到"未分组"
    for (var i = 0; i < next.providers.length; i += 1) {
      if (next.providers[i].groupName === name) {
        next.providers[i].groupName = "";
      }
    }
    if (groupExpanded === name) { setGroupExpanded(""); }
    if (groupEditId === name) { setGroupEditId(""); }
    commit(next);
    ctx.showToast("已删除分组（其下中转站移到未分组）");
  }

  function renameGroup(oldName, newName) {
    var nn = asStr(newName).trim();
    if (!nn || nn === oldName) { setGroupEditId(""); return; }
    if (groupList().indexOf(nn) >= 0) {
      ctx.showToast("该分组名已存在");
      return;
    }
    var next = clone(data);
    for (var i = 0; i < (next.groups || []).length; i += 1) {
      if (next.groups[i] === oldName) { next.groups[i] = nn; }
    }
    for (var j = 0; j < next.providers.length; j += 1) {
      if (next.providers[j].groupName === oldName) { next.providers[j].groupName = nn; }
    }
    setGroupEditId("");
    commit(next);
    ctx.showToast("分组已重命名");
  }

  function setProviderGroup(providerId, groupName) {
    var next = clone(data);
    var pIdx = idxProvider(next.providers, providerId);
    if (pIdx < 0) { return; }
    next.providers[pIdx].groupName = groupName;
    // 确保分组存在于列表
    if (groupName && (!Array.isArray(next.groups) || next.groups.indexOf(groupName) < 0)) {
      if (!Array.isArray(next.groups)) { next.groups = []; }
      next.groups.push(groupName);
    }
    commit(next);
  }

  function syncGroupToProvider(providerName, groupName) {
    var next = clone(data);
    var pIdx = idxProvider(next.providers, providerName);
    if (pIdx < 0) { return; }
    next.providers[pIdx].groupName = groupName;
    commit(next);
  }

  function idxProviderByName(list, name) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].name === name) { return i; }
    }
    return -1;
  }

  // ===== 排序 =====
  // 移动分组：dir = -1 上移 / 1 下移
  function moveGroup(name, dir) {
    var arr = groupList();
    var i = arr.indexOf(name);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) { return; }
    var next = clone(data);
    var tmp = next.groups[i];
    next.groups[i] = next.groups[j];
    next.groups[j] = tmp;
    commit(next);
  }

  // 移动某个分组内的中转站（在其分组内上下移动）
  function moveProviderInGroup(providerId, grpName, dir) {
    var next = clone(data);
    // 收集同组的中转站在 providers 中的索引
    var idxs = [];
    for (var i = 0; i < next.providers.length; i += 1) {
      var g = asStr(next.providers[i].groupName);
      var same = (grpName === "") ? (g === "" || groupList().indexOf(g) < 0) : (g === grpName);
      if (same) { idxs.push(i); }
    }
    var pos = -1;
    for (var k = 0; k < idxs.length; k += 1) {
      if (next.providers[idxs[k]].id === providerId) { pos = k; break; }
    }
    var target = pos + dir;
    if (pos < 0 || target < 0 || target >= idxs.length) { return; }
    var a = idxs[pos];
    var b = idxs[target];
    var tmp = next.providers[a];
    next.providers[a] = next.providers[b];
    next.providers[b] = tmp;
    commit(next);
  }

  // 移动某中转站内的模型
  function moveModelInProvider(providerId, modelId, dir) {
    var next = clone(data);
    var pIdx = idxProvider(next.providers, providerId);
    if (pIdx < 0) { return; }
    var models = next.providers[pIdx].models;
    var i = idxModel(models, modelId);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= models.length) { return; }
    var tmp = models[i];
    models[i] = models[j];
    models[j] = tmp;
    commit(next);
  }

  // ===== 同步面板状态 =====
  var syncOpenState = ctx.useState("price_sync_open", false);
  var syncOpen = syncOpenState[0];
  var setSyncOpen = syncOpenState[1];

  var syncListState = ctx.useState("price_sync_list", []);
  var syncList = syncListState[0];
  var setSyncList = syncListState[1];

  var syncSelState = ctx.useState("price_sync_sel", []);
  var syncSel = syncSelState[0];
  var setSyncSel = syncSelState[1];

  var syncGroupState = ctx.useState("price_sync_group", "");
  var syncGroup = syncGroupState[0];
  var setSyncGroup = syncGroupState[1];

  // ===== 分组选择展开状态（每个中转站单独控制）=====
  var gpState = ctx.useState("price_grouppick_open", "");
  var gpOpenId = gpState[0];
  var setGpOpenId = gpState[1];

  function openSync() {
    var res = readOperitConfigs();
    if (!res.ok || res.configs.length === 0) {
      ctx.showToast("读取软件配置失败" + (res.reason ? ("：" + res.reason) : "（没读到配置）"));
      return;
    }
    var merged = [];
    for (var i = 0; i < res.configs.length; i += 1) {
      var cfg = res.configs[i];
      if (!cfg.name) {
        continue;
      }
      var exist = null;
      for (var j = 0; j < merged.length; j += 1) {
        if (merged[j].name === cfg.name) { exist = merged[j]; break; }
      }
      if (!exist) {
        exist = { name: cfg.name, models: [] };
        merged.push(exist);
      }
      for (var k = 0; k < cfg.models.length; k += 1) {
        if (exist.models.indexOf(cfg.models[k]) < 0) {
          exist.models.push(cfg.models[k]);
        }
      }
    }
    // 标记哪些已存在（并统计可补充的新模型数）；已存在的统一排到列表最后
    var news = [];
    var existings = [];
    for (var f = 0; f < merged.length; f += 1) {
      var item = merged[f];
      var pIdx = idxProviderByName(data.providers, item.name);
      if (pIdx < 0) {
        item.exists = false;
        news.push(item);
      } else {
        var curModels = Array.isArray(data.providers[pIdx].models) ? data.providers[pIdx].models : [];
        var newCnt = 0;
        for (var nm = 0; nm < item.models.length; nm += 1) {
          var has = false;
          for (var cm = 0; cm < curModels.length; cm += 1) {
            if (asStr(curModels[cm].name) === item.models[nm]) { has = true; break; }
          }
          if (!has) { newCnt += 1; }
        }
        item.exists = true;
        item.newModelCount = newCnt;
        existings.push(item);
      }
    }
    var all = news.concat(existings);
    var sel = [];
    for (var m = 0; m < news.length; m += 1) {
      sel.push(news[m].name);
    }
    setSyncList(all);
    setSyncSel(sel);
    setSyncOpen(true);
  }

  function toggleSyncSel(name) {
    var next = syncSel.slice();
    var idx = next.indexOf(name);
    if (idx >= 0) {
      next.splice(idx, 1);
    } else {
      next.push(name);
    }
    setSyncSel(next);
  }

  function doSync() {
    var selected = [];
    for (var i = 0; i < syncList.length; i += 1) {
      if (syncSel.indexOf(syncList[i].name) >= 0) {
        selected.push(syncList[i]);
      }
    }
    if (selected.length === 0) {
      ctx.showToast("请至少勾选一个中转站");
      return;
    }
    var r = mergeConfigsIntoData(data, selected);
    var nextData = r.data;
    // 把这次同步进来的中转站归到选定分组
    var target = asStr(syncGroup).trim();
    if (target) {
      if (!Array.isArray(nextData.groups)) { nextData.groups = []; }
      if (nextData.groups.indexOf(target) < 0) {
        nextData.groups.push(target);
      }
      for (var s = 0; s < selected.length; s += 1) {
        var pIdx = idxProviderByName(nextData.providers, selected[s].name);
        if (pIdx >= 0) {
          nextData.providers[pIdx].groupName = target;
        }
      }
    }
    commit(nextData);
    setSyncOpen(false);
    var msg = "已同步：新增 " + r.addedProviders + " 个中转站、" + r.addedModels + " 个模型";
    if (target) { msg += "（归入分组「" + target + "」）"; }
    ctx.showToast(msg);
  }

  var children = [];

  children.push(ctx.UI.Text({ text: "模型价格管理", style: "titleLarge", fontWeight: "bold" }));
  children.push(ctx.UI.Text({ text: "单价单位：元 / 每百万 token", style: "bodySmall", color: "onSurfaceVariant" }));
  children.push(ctx.UI.Text({ text: "输入/缓存读取/输出：留空 = 0 元", style: "bodySmall", color: "onSurfaceVariant" }));
  children.push(ctx.UI.Text({ text: "缓存写入：留空 = 按输入单价；填 0 = 免费", style: "bodySmall", color: "onSurfaceVariant" }));
  children.push(ctx.UI.Text({ text: "按次单价：按「每次请求」计费时填；留空 = 按 token 计费", style: "bodySmall", color: "onSurfaceVariant" }));
  children.push(ctx.UI.Text({ text: "当前生效：" + describeActive(data), style: "bodyMedium", color: "primary", fontWeight: "bold" }));
  children.push(ctx.UI.Spacer({ height: 8 }));

  // ===== 从软件同步 =====
  children.push(
    ctx.UI.TextButton({
      text: syncOpen ? "收起同步面板" : "⟳ 从软件同步中转站（点这里）",
      onClick: function () {
        if (syncOpen) {
          setSyncOpen(false);
        } else {
          openSync();
        }
      }
    })
  );

  if (syncOpen) {
    var syncBox = [];
    syncBox.push(ctx.UI.Text({
      text: "从 Operit 软件读取到的中转站（勾选要同步的）：",
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
    for (var si = 0; si < syncList.length; si += 1) {
      (function (item) {
        var on = syncSel.indexOf(item.name) >= 0;
        var subText;
        if (item.exists) {
          subText = item.newModelCount > 0
            ? ("已导入 · 可补 " + item.newModelCount + " 个新模型")
            : "已导入 · 无新模型";
        } else {
          subText = item.models.length + " 个模型 · 新";
        }
        syncBox.push(
          ctx.UI.Row(
            {
              fillMaxWidth: true,
              verticalAlignment: "center",
              horizontalArrangement: "spaceBetween",
              onClick: function () { toggleSyncSel(item.name); }
            },
            [
              ctx.UI.Text({ text: (on ? "☑ " : "☐ ") + item.name, style: "bodyMedium", fontWeight: on ? "bold" : "normal" }),
              ctx.UI.Text({ text: subText, style: "bodySmall", color: item.exists ? "onSurfaceVariant" : "primary" })
            ]
          )
        );
      })(syncList[si]);
    }
    syncBox.push(ctx.UI.Spacer({ height: 6 }));
    syncBox.push(ctx.UI.Text({
      text: "同步到分组（可选，留空 = 未分组）：",
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
    syncBox.push(
      ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "spaceBetween" }, [
        (function () {
          var chips = [];
          chips.push(ctx.UI.TextButton({
            text: (syncGroup === "" ? "● 未分组" : "○ 未分组"),
            onClick: function () { setSyncGroup(""); }
          }));
          for (var gi = 0; gi < groupList().length; gi += 1) {
            (function (gname) {
              chips.push(ctx.UI.TextButton({
                text: (syncGroup === gname ? "● " : "○ ") + gname,
                onClick: function () { setSyncGroup(gname); }
              }));
            })(groupList()[gi]);
          }
          return ctx.UI.Column({ fillMaxWidth: true, spacing: 2 }, chips);
        })()
      ])
    );
    syncBox.push(ctx.UI.Text({
      text: "说明：新中转站排在上面，已导入的排在下面；勾选已导入的可补充它的新模型。只新增，不动已有价格。",
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
    syncBox.push(
      ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "spaceBetween" }, [
        ctx.UI.Column({ weight: 1 }, [
          ctx.UI.TextButton({
            text: "全部选中",
            onClick: function () {
              var all = [];
              for (var z = 0; z < syncList.length; z += 1) { all.push(syncList[z].name); }
              setSyncSel(all);
            }
          })
        ]),
        ctx.UI.Column({ weight: 1 }, [
          ctx.UI.TextButton({
            text: "全部不选",
            onClick: function () {
              setSyncSel([]);
            }
          })
        ])
      ])
    );
    syncBox.push(
      ctx.UI.TextButton({
        text: "⇩ 同步勾选的 " + syncSel.length + " 个",
        onClick: doSync
      })
    );
    children.push(ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ fillMaxWidth: true, spacing: 4 }, syncBox)
    ]));
  }

  children.push(ctx.UI.Spacer({ height: 12 }));

  // ===== 分组管理 =====
  children.push(ctx.UI.Text({ text: "分组管理", style: "titleMedium", fontWeight: "bold" }));
  children.push(ctx.UI.Text({
    text: "把中转站归类，便于查找（例如：便宜的 / 官方的 / 备用的）。",
    style: "bodySmall",
    color: "onSurfaceVariant"
  }));

  var groups = groupList();
  if (groups.length === 0) {
    children.push(ctx.UI.Text({ text: "还没有分组。下面添加一个。", style: "bodySmall", color: "onSurfaceVariant" }));
  } else {
    var gCard = [];
    for (var gi2 = 0; gi2 < groups.length; gi2 += 1) {
      (function (gname) {
        // 统计该分组下的中转站数
        var cnt = 0;
        for (var t = 0; t < data.providers.length; t += 1) {
          if (data.providers[t].groupName === gname) { cnt += 1; }
        }
        if (groupEditId === gname) {
          gCard.push(
            ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", horizontalArrangement: "spaceBetween" }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextField({
                  label: "重命名分组",
                  value: gname,
                  singleLine: true,
                  onValueChange: function (v) { renameGroup(gname, v); }
                })
              ]),
              ctx.UI.TextButton({ text: "取消", onClick: function () { setGroupEditId(""); } })
            ])
          );
        } else {
          gCard.push(
            ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", horizontalArrangement: "spaceBetween" }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.Text({ text: "📁 " + gname, style: "bodyMedium", fontWeight: "bold" }),
                ctx.UI.Text({ text: cnt + " 个中转站", style: "bodySmall", color: "onSurfaceVariant" })
              ]),
              ctx.UI.Row({ verticalAlignment: "center" }, [
                ctx.UI.TextButton({ text: "改名", onClick: function () { setGroupEditId(gname); } }),
                ctx.UI.TextButton({ text: "删除", onClick: function () { removeGroup(gname); } })
              ])
            ])
          );
        }
        gCard.push(ctx.UI.Surface({ fillMaxWidth: true, height: 1, containerColor: "outlineVariant" }));
      })(groups[gi2]);
    }
    children.push(ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ fillMaxWidth: true, spacing: 4 }, gCard)
    ]));
  }

  children.push(
    ctx.UI.TextField({
      label: "新分组名称",
      value: newGroupName,
      singleLine: true,
      onValueChange: setNewGroupName
    })
  );
  children.push(
    ctx.UI.TextButton({ text: "＋ 添加分组", onClick: addGroup })
  );

  children.push(ctx.UI.Spacer({ height: 12 }));

  // ===== 中转站列表（按分组归类显示）=====
  children.push(ctx.UI.Text({ text: "中转站（按分组）", style: "titleMedium", fontWeight: "bold" }));

  var providers = Array.isArray(data.providers) ? data.providers : [];
  if (providers.length === 0) {
    children.push(ctx.UI.Text({ text: "还没有中转站，往下滑添加一个。", style: "bodyMedium", color: "onSurfaceVariant" }));
  }

  // 构建分组 -> 中转站索引列表（未分组放最后）
  var displayGroups = [];
  for (var dg = 0; dg < groups.length; dg += 1) {
    displayGroups.push(groups[dg]);
  }
  displayGroups.push("");  // 未分组

  function renderProviderCard(provider, grpKey, posInGroup, groupSize) {
    var isOpen = expandedId === provider.id;
    var models = Array.isArray(provider.models) ? provider.models : [];
    var block = [];
    block.push(
      ctx.UI.Row(
        {
          fillMaxWidth: true,
          verticalAlignment: "center",
          horizontalArrangement: "spaceBetween",
          onClick: function () { toggleProvider(provider.id); }
        },
        [
          ctx.UI.Column({ weight: 1 }, [
            ctx.UI.Text({ text: provider.name || "(未命名中转站)", style: "titleMedium", fontWeight: "bold" }),
            ctx.UI.Text({ text: models.length + " 个模型 · " + (isOpen ? "点此收起" : "点此展开"), style: "bodySmall", color: "onSurfaceVariant" })
          ]),
          ctx.UI.Row({ verticalAlignment: "center" }, [
            ctx.UI.TextButton({ text: "上", enabled: posInGroup > 0, onClick: function () { moveProviderInGroup(provider.id, grpKey, -1); } }),
            ctx.UI.TextButton({ text: "下", enabled: posInGroup < groupSize - 1, onClick: function () { moveProviderInGroup(provider.id, grpKey, 1); } }),
            ctx.UI.Icon({ name: isOpen ? "ExpandLess" : "ExpandMore" })
          ])
        ]
      )
    );

    if (isOpen) {
      var inner = [];
      inner.push(
        ctx.UI.TextField({
          label: "中转站名称（用于自动匹配，建议与软件里一致）",
          value: provider.name || "",
          singleLine: true,
          onValueChange: function (v) { patchProvider(provider.id, "name", v); }
        })
      );
      // 所属分组（点标题展开/收起，不一次全显示）
      inner.push(
        ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", horizontalArrangement: "spaceBetween", onClick: function () { setGpOpenId(gpOpenId === provider.id ? "" : provider.id); } }, [
          ctx.UI.Text({ text: "所属分组：" + ((provider.groupName || "") === "" ? "未分组" : provider.groupName), style: "bodySmall", color: "onSurfaceVariant" }),
          ctx.UI.Text({ text: (gpOpenId === provider.id ? "▼ " : "▶ ") + "选择", style: "bodySmall", color: "primary" })
        ])
      );
      if (gpOpenId === provider.id) {
        var gChips = [];
        gChips.push(ctx.UI.TextButton({
          text: ((provider.groupName || "") === "" ? "● 未分组" : "○ 未分组"),
          onClick: function () { setProviderGroup(provider.id, ""); setGpOpenId(""); }
        }));
        for (var gc = 0; gc < groups.length; gc += 1) {
          (function (gname) {
            gChips.push(ctx.UI.TextButton({
              text: ((provider.groupName || "") === gname ? "● " : "○ ") + gname,
              onClick: function () { setProviderGroup(provider.id, gname); setGpOpenId(""); }
            }));
          })(groups[gc]);
        }
        inner.push(ctx.UI.Row({ fillMaxWidth: true }, [ctx.UI.Column({ fillMaxWidth: true, spacing: 2 }, gChips)]));
      }

      if (models.length === 0) {
        inner.push(ctx.UI.Text({ text: "该中转站下还没有模型，点“添加模型”。", style: "bodySmall", color: "onSurfaceVariant" }));
      }
      for (var mi = 0; mi < models.length; mi += 1) {
        (function (model, modelPos, modelTotal) {
          var active = isActive(provider.id, model.id);
          var cardChildren = [];
          var mOpen = (modelExpandedId === model.id);
          var sumText;
          if (model.perRequest && String(model.perRequest).length > 0) {
            sumText = "按次 ¥" + model.perRequest + " / 次";
          } else {
            sumText = "入 " + (model.input || "0") + " · 缓读 " + (model.cached || "0") + " · 出 " + (model.output || "0");
          }
          cardChildren.push(
            ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", horizontalArrangement: "spaceBetween", onClick: function () { toggleModel(model.id); } }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.Text({ text: (mOpen ? "▼ " : "▶ ") + (model.name || "(未命名模型)") + (active ? "   ● 当前生效" : ""), style: "bodyMedium", fontWeight: "bold" }),
                ctx.UI.Text({ text: sumText, style: "bodySmall", color: "onSurfaceVariant" })
              ]),
              ctx.UI.Row({ verticalAlignment: "center" }, [
                ctx.UI.TextButton({ text: "上", enabled: modelPos > 0, onClick: function () { moveModelInProvider(provider.id, model.id, -1); } }),
                ctx.UI.TextButton({ text: "下", enabled: modelPos < modelTotal - 1, onClick: function () { moveModelInProvider(provider.id, model.id, 1); } })
              ])
            ])
          );
          if (mOpen) {
          cardChildren.push(
            ctx.UI.TextField({
              label: "模型名称（用于自动匹配，需与软件一致）",
              value: model.name || "",
              singleLine: true,
              onValueChange: function (v) { patchModel(provider.id, model.id, "name", v); }
            })
          );
          cardChildren.push(
            ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "spaceBetween" }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextField({
                  label: "输入（未缓存，空=0）",
                  value: model.input || "",
                  singleLine: true,
                  onValueChange: function (v) { patchModel(provider.id, model.id, "input", v); }
                })
              ]),
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextField({
                  label: "缓存读取（空=0）",
                  value: model.cached || "",
                  singleLine: true,
                  onValueChange: function (v) { patchModel(provider.id, model.id, "cached", v); }
                })
              ])
            ])
          );
          cardChildren.push(
            ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "spaceBetween" }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextField({
                  label: "缓存写入（空=输入价）",
                  value: model.cacheWrite || "",
                  singleLine: true,
                  onValueChange: function (v) { patchModel(provider.id, model.id, "cacheWrite", v); }
                })
              ]),
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextField({
                  label: "输出（空=0）",
                  value: model.output || "",
                  singleLine: true,
                  onValueChange: function (v) { patchModel(provider.id, model.id, "output", v); }
                })
              ])
            ])
          );
          cardChildren.push(
            ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "spaceBetween" }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextField({
                  label: "按次单价（空=不分次）",
                  value: model.perRequest || "",
                  singleLine: true,
                  onValueChange: function (v) { patchModel(provider.id, model.id, "perRequest", v); }
                })
              ]),
              ctx.UI.Column({ weight: 1 }, [])
            ])
          );
          cardChildren.push(
            ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "spaceBetween" }, [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextButton({
                  text: active ? "已设为当前" : "设为当前",
                  enabled: !active,
                  onClick: function () { setActive(provider.id, model.id); }
                })
              ]),
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.TextButton({
                  text: "删除模型",
                  onClick: function () { removeModel(provider.id, model.id); }
                })
              ])
            ])
          );
}
          inner.push(ctx.UI.Card({ fillMaxWidth: true }, [
              ctx.UI.Column({ fillMaxWidth: true, spacing: 6 }, cardChildren)
            ]));
        })(models[mi], mi, models.length);
      }

      inner.push(
        ctx.UI.TextButton({
          text: "＋ 添加模型",
          onClick: function () { addModel(provider.id); }
        })
      );
      inner.push(
        ctx.UI.TextButton({
          text: "删除该中转站",
          onClick: function () { removeProvider(provider.id); }
        })
      );

      block.push(
        ctx.UI.Column({ fillMaxWidth: true, spacing: 6 }, inner)
      );
    }

    return ctx.UI.Card({ fillMaxWidth: true }, [
      ctx.UI.Column({ fillMaxWidth: true, spacing: 8 }, block)
    ]);
  }

  for (var dgi = 0; dgi < displayGroups.length; dgi += 1) {
    (function (grpName) {
      var grpProviders = [];
      for (var pp = 0; pp < providers.length; pp += 1) {
        var pg2 = asStr(providers[pp].groupName);
        if (grpName === "") {
          // 未分组：groupName 为空且不属于已删除的分组
          if (pg2 === "" || groups.indexOf(pg2) < 0) { grpProviders.push(providers[pp]); }
        } else if (pg2 === grpName) {
          grpProviders.push(providers[pp]);
        }
      }
      if (grpProviders.length === 0 && grpName !== "") {
        return;
      }
      var groupKey = (grpName === "" ? "__nogroup__" : grpName);
      var isGroupOpen = (grpName === "") || (groupExpanded === groupKey);
      var grpInner = [];
      // 分组标题（可折叠）
      if (grpName !== "") {
        children.push(
          ctx.UI.Row(
            {
              fillMaxWidth: true,
              verticalAlignment: "center",
              horizontalArrangement: "spaceBetween",
              onClick: function () {
                setGroupExpanded(groupExpanded === groupKey ? "" : groupKey);
              }
            },
            [
              ctx.UI.Column({ weight: 1 }, [
                ctx.UI.Text({ text: (isGroupOpen ? "▼ " : "▶ ") + "分组：" + grpName + "（" + grpProviders.length + "）", style: "titleMedium", fontWeight: "bold", color: "primary" }),
                ctx.UI.Text({ text: isGroupOpen ? "点此收起" : "点此展开", style: "bodySmall", color: "onSurfaceVariant" })
              ]),
              ctx.UI.Row({ verticalAlignment: "center" }, [
                ctx.UI.TextButton({ text: "上", onClick: function () { moveGroup(grpName, -1); } }),
                ctx.UI.TextButton({ text: "下", onClick: function () { moveGroup(grpName, 1); } })
              ])
            ]
          )
        );
        if (!isGroupOpen) {
          return;   // 折叠状态不渲染其中转站
        }
      } else {
        if (groups.length > 0) {
          children.push(ctx.UI.Text({ text: "— 未分组 —", style: "titleSmall", color: "onSurfaceVariant" }));
        }
      }

      for (var q = 0; q < grpProviders.length; q += 1) {
        grpInner.push(renderProviderCard(grpProviders[q], grpName, q, grpProviders.length));
        grpInner.push(ctx.UI.Spacer({ height: 10 }));
      }
      if (grpInner.length > 0) {
        children.push(
          ctx.UI.Column({ fillMaxWidth: true, spacing: 0 }, grpInner)
        );
      }
    })(displayGroups[dgi]);
  }

  children.push(ctx.UI.Spacer({ height: 16 }));
  children.push(ctx.UI.Text({ text: "添加中转站", style: "titleMedium", fontWeight: "bold" }));
  children.push(
    ctx.UI.TextField({
      label: "中转站名称",
      value: newProviderName,
      singleLine: true,
      onValueChange: setNewProviderName
    })
  );
  children.push(
    ctx.UI.TextButton({
      text: "＋ 添加中转站",
      onClick: addProvider
    })
  );
  children.push(ctx.UI.Spacer({ height: 24 }));

  return ctx.UI.LazyColumn({ spacing: 8 }, children);
}
