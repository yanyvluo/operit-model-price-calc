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

// 找到当前生效的那组价格
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

// "OPENAI_GENERIC/MyProvider" -> "MyProvider"；"ZHIPU" -> "ZHIPU"
function splitProviderName(provider) {
  var s = asStr(provider);
  var i = s.lastIndexOf("/");
  return i >= 0 ? s.substring(i + 1) : s;
}

// 归一化：去首尾空格、转小写、去所有空白
function normName(s) {
  return asStr(s).replace(/\s+/g, "").toLowerCase();
}

// 宽松相等：完全相同，或互为子串（如 `abc` ⊂ `abc中转`）
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

// 按「中转站名 + 模型名」匹配；中转站没对上但有同名模型，也算次优先命中
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

// 读数据库：按时间窗统计本次请求次数
// 窗口 = [sentAt, sentAt + waitDurationMs + outputDurationMs + 余量]
function queryRequestCount(sentAt, waitMs, outMs) {
  var result = { ok: false, count: 0, reason: "" };
  var s = parseFloat(sentAt);
  if (!isFinite(s) || s <= 0) {
    result.reason = "no_sentAt";
    return result;
  }
  var w = isFinite(parseFloat(waitMs)) ? parseFloat(waitMs) : 0;
  var d = isFinite(parseFloat(outMs)) ? parseFloat(outMs) : 0;
  // 结束时间 = 开始 + 首包等待 + 生成耗时（实测误差仅数毫秒），再给 1 秒余量兜边界
  var end = s + w + d + 1000;
  try {
    var ctx = getContext();
    if (!ctx) { result.reason = "no_context"; return result; }
    var dbPath = ctx.getDatabasePath("app_database").getAbsolutePath();
    var SQLiteDatabase = Java.use("android.database.sqlite.SQLiteDatabase");
    var db = SQLiteDatabase.openDatabase(dbPath, null, 1);
    try {
      var c = db.rawQuery(
        "SELECT COUNT(*) FROM token_usage_records WHERE occurredAtMs>=? AND occurredAtMs<=?",
        [String(Math.floor(s)), String(Math.ceil(end))]
      );
      if (c.moveToFirst()) {
        result.count = c.getLong(0);
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

function label(text) {
  return { text: text };
}

function Screen(ctx) {
  var messageCell = useStateCell(ctx, "message", null);
  var message = messageCell.value || {};

  var data = loadData();
  var matched = findPriceForMessage(data, message);
  var activePrice = matched || findActivePrice(data);
  var usedFallback = !matched;

  var totalInput = numOf(message.inputTokens);
  var cachedInput = numOf(message.cachedInputTokens);
  var outputTokens = numOf(message.outputTokens);
  var uncachedInput = Math.max(0, totalInput - cachedInput);

  var msgModel = asStr(message.modelName) || "(未知)";
  var msgProvider = asStr(message.provider) || "";

  var rows = [];

  rows.push(ctx.UI.Text({ text: "这条回答花了多少", style: "titleMedium", fontWeight: "bold" }));
  rows.push(ctx.UI.Text({
    text: "模型：" + msgModel + (msgProvider ? ("（" + msgProvider + "）") : ""),
    style: "bodyMedium",
    color: "onSurfaceVariant"
  }));

  if (!activePrice) {
    rows.push(ctx.UI.Text({
      text: "还没有配置价格。请到侧边栏「模型价格」里，为模型填好单价后再看。",
      style: "bodyMedium",
      color: "error"
    }));
    return ctx.UI.AlertDialog({
      title: "本条费用",
      text: ctx.UI.Column({ spacing: 10 }, rows),
      dismissText: "关闭",
      confirmText: "关闭",
      closeOnConfirm: true,
      closeOnDismiss: true,
      onConfirm: function () {}
    });
  }

  var model = activePrice.model || {};
  var inputPrice = numOf(model.input);
  var cachedPrice = numOf(model.cached);
  var cwStr = asStr(model.cacheWrite).trim();
  var cacheWritePrice = (cwStr === "") ? inputPrice : numOf(model.cacheWrite);
  var outputPrice = numOf(model.output);
  var perRequestPrice = numOf(model.perRequest);
  var byCount = perRequestPrice > 0;

  // 本次请求次数（读数据库时间窗）
  var reqInfo = queryRequestCount(message.sentAt, message.waitDurationMs, message.outputDurationMs);
  var reqCount = reqInfo.ok ? reqInfo.count : 0;

  var costInput = uncachedInput * inputPrice / 1000000;
  var costCached = cachedInput * cachedPrice / 1000000;
  var costOutput = outputTokens * outputPrice / 1000000;
  var costByToken = costInput + costCached + costOutput;
  var costByCount = reqCount * perRequestPrice;
  var costTotal = byCount ? costByCount : costByToken;

  // 匹配结果标注
  var cfgModel = asStr(model.name);
  var cfgProvider = asStr(activePrice.provider && activePrice.provider.name);
  if (matched) {
    rows.push(ctx.UI.Text({
      text: "✓ 已自动匹配价格：中转站「" + (cfgProvider || "?") + "」/ 模型「" + (cfgModel || "?") + "」" +
        (matched.strict ? "" : "（只对上模型名，中转站名没对上）"),
      style: "bodySmall",
      color: matched.strict ? "primary" : "error"
    }));
  } else {
    rows.push(ctx.UI.Text({
      text: "⚠ 没找到与这条消息（" + splitProviderName(msgProvider) + " / " + msgModel + "）对应的价格，" +
        "现在用的是「当前生效」的 " + (cfgProvider || "?") + " / " + (cfgModel || "(未命名)") + "，结果仅供参考。",
      style: "bodySmall",
      color: "error"
    }));
  }

  rows.push(ctx.UI.Text({ text: "— 用量 —", style: "labelLarge", color: "primary", fontWeight: "medium" }));
  var reqText = reqInfo.ok ? (reqCount + " 次") : ("读取失败（" + (reqInfo.reason || "未知") + "）");
  rows.push(ctx.UI.Text({ text: "本次请求次数：" + reqText, style: "bodyMedium", fontWeight: "bold", color: "primary" }));
  rows.push(ctx.UI.Text({ text: "未缓存输入：" + fmtInt(uncachedInput) + " token", style: "bodyMedium" }));
  rows.push(ctx.UI.Text({ text: "缓存读取：" + fmtInt(cachedInput) + " token", style: "bodyMedium" }));
  rows.push(ctx.UI.Text({ text: "输出：" + fmtInt(outputTokens) + " token", style: "bodyMedium" }));

  rows.push(ctx.UI.Text({ text: "— 单价（元/百万） —", style: "labelLarge", color: "primary", fontWeight: "medium" }));
  rows.push(ctx.UI.Text({ text: "输入：" + (asStr(model.input) || "0") + (inputPrice ? "" : "（未填→按0）"), style: "bodySmall", color: "onSurfaceVariant" }));
  rows.push(ctx.UI.Text({ text: "缓存读取：" + (asStr(model.cached) || "0") + (cachedPrice ? "" : "（未填→按0）"), style: "bodySmall", color: "onSurfaceVariant" }));
  rows.push(ctx.UI.Text({
    text: "缓存写入：" + (cwStr === "" ? "同输入价" : (cwStr === "0" ? "免费" : cwStr)),
    style: "bodySmall",
    color: "onSurfaceVariant"
  }));
  rows.push(ctx.UI.Text({ text: "输出：" + (asStr(model.output) || "0") + (outputPrice ? "" : "（未填→按0）"), style: "bodySmall", color: "onSurfaceVariant" }));
  if (byCount) {
    rows.push(ctx.UI.Text({ text: "按次单价：" + asStr(model.perRequest) + " 元/次（本模型按次计费）", style: "bodySmall", color: "primary" }));
  }

  rows.push(ctx.UI.Surface({ fillMaxWidth: true, height: 1, containerColor: "outlineVariant" }));
  rows.push(ctx.UI.Text({
    text: "本条费用：¥ " + fmtMoney(costTotal),
    style: "titleMedium",
    color: "primary",
    fontWeight: "bold"
  }));
  if (byCount) {
    rows.push(ctx.UI.Text({
      text: "（" + reqCount + " 次 × " + asStr(model.perRequest) + " 元）",
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
    rows.push(ctx.UI.Text({
      text: "按 token 算则为 ¥ " + fmtMoney(costByToken) + "（仅供参考）",
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
  } else {
    rows.push(ctx.UI.Text({
      text: "（输入 " + fmtMoney(costInput) + " + 缓存 " + fmtMoney(costCached) + " + 输出 " + fmtMoney(costOutput) + "）",
      style: "bodySmall",
      color: "onSurfaceVariant"
    }));
  }

  return ctx.UI.AlertDialog({
    title: "本条费用",
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
