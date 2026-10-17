"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;

// ---- 与价格配置页共用同一份存储 ----
var PREFS_NAME = "toolpkg_price_calc";
var DATA_KEY = "price_calc_data_v1";

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

function loadData() {
  var prefs = getPrefs();
  if (!prefs) {
    return { providers: [], active: {} };
  }
  try {
    var raw = asStr(prefs.getString(DATA_KEY, "")).trim();
    if (!raw) {
      return { providers: [], active: {} };
    }
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : { providers: [], active: {} };
  } catch (e) {
    return { providers: [], active: {} };
  }
}

function findActivePrice(data) {
  var active = (data && data.active) ? data.active : {};
  var providers = (data && Array.isArray(data.providers)) ? data.providers : [];
  for (var i = 0; i < providers.length; i += 1) {
    if (providers[i].id === active.providerId) {
      var models = Array.isArray(providers[i].models) ? providers[i].models : [];
      for (var j = 0; j < models.length; j += 1) {
        if (models[j].id === active.modelId) {
          return { provider: providers[i], model: models[j] };
        }
      }
    }
  }
  return null;
}

function numOf(s) {
  var v = parseFloat(asStr(s).trim());
  return isFinite(v) ? v : 0;
}

// ---- 自动匹配：先中转站，再模型 ----
function splitProviderName(provider) {
  var s = asStr(provider);
  var i = s.lastIndexOf("/");
  return i >= 0 ? s.substring(i + 1) : s;
}

function normName(s) {
  return asStr(s).replace(/\s+/g, "").toLowerCase();
}

function looseEq(a, b) {
  var x = normName(a);
  var y = normName(b);
  if (!x || !y) {
    return false;
  }
  if (x === y) {
    return true;
  }
  return x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

function findPriceForMessage(data, msg) {
  var providers = (data && Array.isArray(data.providers)) ? data.providers : [];
  var msgProv = splitProviderName(msg.provider);
  var msgModel = asStr(msg.modelName);
  var modelOnly = null;
  for (var i = 0; i < providers.length; i += 1) {
    var p = providers[i];
    var provOk = looseEq(p.name, msgProv);
    var models = Array.isArray(p.models) ? p.models : [];
    for (var j = 0; j < models.length; j += 1) {
      var m = models[j];
      if (looseEq(m.name, msgModel)) {
        if (provOk) {
          return { provider: p, model: m, by: "provider+model", strict: true };
        }
        if (!modelOnly) {
          modelOnly = { provider: p, model: m, by: "model", strict: false };
        }
      }
    }
  }
  return modelOnly;
}

// 计算单条消息（明细项）的费用；hit 为匹配到的价格组
function costOfItem(item, m) {
  var ip = numOf(m.input);
  var cp = numOf(m.cached);
  var op = numOf(m.output);
  var pr = numOf(m.perRequest);
  if (pr > 0) {
    return { cost: item.requestCount * pr, byCount: true };
  }
  var uncached = Math.max(0, item.inputTokens - item.cachedInputTokens);
  var cost = uncached * ip / 1000000 + item.cachedInputTokens * cp / 1000000 + item.outputTokens * op / 1000000;
  return { cost: cost, byCount: false };
}

function fmtInt(n) {
  var v = Math.round(numOf(n));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtMoney(v) {
  if (!isFinite(v) || v <= 0) {
    return "0";
  }
  if (v < 0.000001) {
    return v.toExponential(3);
  }
  var s = v.toFixed(8);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function useStateCell(ctx, key, initialValue) {
  var pair = ctx.useState(key, initialValue);
  return { value: pair[0], set: pair[1] };
}

// 读数据库：取某个对话的全部 AI 消息明细（含每条的中转站/模型/token/请求次数）
function queryChatItems(chatId) {
  var result = { ok: false, items: [], reason: "" };
  if (!chatId) {
    result.reason = "no_chatId";
    return result;
  }
  try {
    var ctx = getContext();
    if (!ctx) { result.reason = "no_context"; return result; }
    var dbPath = ctx.getDatabasePath("app_database").getAbsolutePath();
    var SQLiteDatabase = Java.use("android.database.sqlite.SQLiteDatabase");
    var db = SQLiteDatabase.openDatabase(dbPath, null, 1);
    try {
      var c = db.rawQuery(
        "SELECT provider, modelName, COALESCE(inputTokens,0), COALESCE(cachedInputTokens,0), COALESCE(outputTokens,0), " +
        "COALESCE(sentAt,0), COALESCE(waitDurationMs,0), COALESCE(outputDurationMs,0) " +
        "FROM messages WHERE chatId=? AND sender='ai' ORDER BY sentAt ASC",
        [String(chatId)]
      );
      while (c.moveToNext()) {
        var s = c.getLong(5);
        var w = c.getLong(6);
        var d = c.getLong(7);
        var cnt = 0;
        if (s > 0) {
          var cr = db.rawQuery(
            "SELECT COUNT(*) FROM token_usage_records WHERE occurredAtMs>=? AND occurredAtMs<=?",
            [String(s), String(Math.ceil(s + w + d + 1000))]
          );
          if (cr.moveToFirst()) {
            cnt = cr.getLong(0);
          }
          cr.close();
        }
        result.items.push({
          provider: c.getString(0) || "",
          modelName: c.getString(1) || "",
          inputTokens: c.getLong(2),
          cachedInputTokens: c.getLong(3),
          outputTokens: c.getLong(4),
          requestCount: cnt
        });
      }
      c.close();
      result.ok = true;
    } finally {
      db.close();
    }
  } catch (e) {
    result.reason = String(e);
  }
  return result;
}

function Screen(ctx) {
  var chatIdCell = useStateCell(ctx, "chatId", "");
  var chatId = asStr(chatIdCell.value);

  var data = loadData();
  var activePrice = findActivePrice(data);

  var rows = [];
  rows.push(ctx.UI.Text({ text: "本对话总花费", style: "titleMedium", fontWeight: "bold" }));

  var res = queryChatItems(chatId);

  if (!res.ok) {
    rows.push(ctx.UI.Text({
      text: "读取对话数据失败：" + (res.reason || "未知原因"),
      style: "bodyMedium",
      color: "error"
    }));
    return ctx.UI.AlertDialog({
      title: "本对话费用",
      text: ctx.UI.Column({ spacing: 10 }, rows),
      dismissText: "关闭",
      confirmText: "关闭",
      closeOnConfirm: true,
      closeOnDismiss: true,
      onConfirm: function () {}
    });
  }

  // 逐条自动匹配 + 累加（按每条自己的模型算）
  var sumCost = 0;
  var sumCostTokenEquiv = 0;
  var matchedCount = 0;
  var skipped = [];
  var byModel = {};
  var totalRequests = 0;
  var totalUncached = 0;
  var totalCached = 0;
  var totalOutput = 0;

  for (var k = 0; k < res.items.length; k += 1) {
    var it = res.items[k];
    totalRequests += it.requestCount;
    totalUncached += Math.max(0, it.inputTokens - it.cachedInputTokens);
    totalCached += it.cachedInputTokens;
    totalOutput += it.outputTokens;

    var hit = findPriceForMessage(data, it);
    if (hit) {
      matchedCount += 1;
      var c = costOfItem(it, hit.model);
      sumCost += c.cost;
      var key = splitProviderName(it.provider) + " / " + asStr(it.modelName);
      if (!byModel[key]) {
        byModel[key] = { cost: 0, count: 0, provider: hit.provider, model: hit.model };
      }
      byModel[key].cost += c.cost;
      byModel[key].count += 1;
    } else {
      skipped.push(splitProviderName(it.provider) + " / " + asStr(it.modelName));
    }
  }

  rows.push(ctx.UI.Text({
    text: "AI 回答数：" + res.items.length + " 条（自动匹配到价格 " + matchedCount + " 条）",
    style: "bodyMedium",
    color: "onSurfaceVariant"
  }));

  if (matchedCount === 0) {
    rows.push(ctx.UI.Text({
      text: "没有任何一条消息匹配到价格。请到侧边栏「模型价格」里，按「中转站名 + 模型名」把价格配上（名称要与软件里的一致）。",
      style: "bodyMedium",
      color: "error"
    }));
    return ctx.UI.AlertDialog({
      title: "本对话费用",
      text: ctx.UI.Column({ spacing: 10 }, rows),
      dismissText: "关闭",
      confirmText: "关闭",
      closeOnConfirm: true,
      closeOnDismiss: true,
      onConfirm: function () {}
    });
  }

  rows.push(ctx.UI.Surface({ fillMaxWidth: true, height: 1, containerColor: "outlineVariant" }));
  rows.push(ctx.UI.Text({ text: "— 按模型分组 —", style: "labelLarge", color: "primary", fontWeight: "medium" }));

  var keys = [];
  for (var kk in byModel) {
    if (Object.prototype.hasOwnProperty.call(byModel, kk)) {
      keys.push(kk);
    }
  }
  keys.sort(function (a, b) { return byModel[b].cost - byModel[a].cost; });
  for (var ki = 0; ki < keys.length; ki += 1) {
    var g = byModel[keys[ki]];
    rows.push(ctx.UI.Text({
      text: "· " + keys[ki] + "：" + g.count + " 条 · ¥ " + fmtMoney(g.cost),
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
  }

  if (skipped.length > 0) {
    var uniq = [];
    for (var si = 0; si < skipped.length; si += 1) {
      if (uniq.indexOf(skipped[si]) < 0) {
        uniq.push(skipped[si]);
      }
    }
    rows.push(ctx.UI.Text({
      text: "⚠ 有 " + skipped.length + " 条没匹配到价格，已跳过（未计入金额）：" + uniq.join("、"),
      style: "bodySmall",
      color: "error"
    }));
  }

  rows.push(ctx.UI.Surface({ fillMaxWidth: true, height: 1, containerColor: "outlineVariant" }));
  rows.push(ctx.UI.Text({ text: "— 累计用量 —", style: "labelLarge", color: "primary", fontWeight: "medium" }));
  rows.push(ctx.UI.Text({ text: "总请求次数：" + fmtInt(totalRequests) + " 次", style: "bodyMedium", fontWeight: "bold", color: "primary" }));
  rows.push(ctx.UI.Text({ text: "未缓存输入：" + fmtInt(totalUncached) + " token", style: "bodyMedium" }));
  rows.push(ctx.UI.Text({ text: "缓存读取：" + fmtInt(totalCached) + " token", style: "bodyMedium" }));
  rows.push(ctx.UI.Text({ text: "输出：" + fmtInt(totalOutput) + " token", style: "bodyMedium" }));

  rows.push(ctx.UI.Surface({ fillMaxWidth: true, height: 1, containerColor: "outlineVariant" }));
  rows.push(ctx.UI.Text({
    text: "本对话总费用：¥ " + fmtMoney(sumCost),
    style: "titleMedium",
    color: "primary",
    fontWeight: "bold"
  }));
  rows.push(ctx.UI.Text({
    text: "（逐条按各自模型的价格计算后求和）",
    style: "bodySmall",
    color: "onSurfaceVariant"
  }));

  return ctx.UI.AlertDialog({
    title: "本对话费用",
    text: ctx.UI.LazyColumn({
      spacing: 8,
      modifier: ctx.Modifier.heightIn({ max: 460 }).toJSON()
    }, rows),
    dismissText: "关闭",
    confirmText: "关闭",
    closeOnConfirm: true,
    closeOnDismiss: true,
    onConfirm: function () {}
  });
}