/**
 * analytics.js — 落地页漏斗埋点。
 *
 * 只有一件事要回答：**哪条渠道带来了多少次下载点击。**
 * 所以这里刻意不做用户识别：没有 Cookie、没有 localStorage 长期标识、
 * 不采集 UA、不采集屏幕尺寸、不做跨会话拼接。来源标识只放 sessionStorage
 * （关掉标签页就没了），它连「同一个人的第二次访问」都串不起来。
 *
 * 事件名必须与 Worker 侧 src/ops.ts 的 ALLOWED_EVENTS 一致，否则会被静默丢弃。
 *
 * ## 口径 v2（2026-11-15 起）
 *
 * v1 在 DOMContentLoaded 立刻发 view，代价是分母不可信：打开又立刻关掉、
 * cmd+click 到后台标签、预渲染、自动化浏览器，全都算一次浏览；同一人反复点
 * 同一个按钮也每次都计数。分子虚高、分母也虚高，两个方向还不对称，算出的
 * 点击率既不可复现也不可比较。
 *
 * v2 改三处，其余（端点、字段、事件名）一律不动：
 *
 * 1. **view 要等页面真正被看到**：`visibilityState === "visible"` 之后，
 *    再停留满 `VIEW_DWELL_MS` 才发。后台标签页切回来才计时，切走则取消。
 *    期间用户点了任何 `[data-track]` 按钮，先把 view 补发再发点击——
 *    保证「点击 ≤ 浏览」不会倒挂。
 * 2. **同一会话内同一个 (事件名, 位置) 只发一次**：以 sessionStorage 标记，
 *    标签页关闭即失效。指标语义因此从「点击数」变成「会话级转化率」，
 *    即「看过这个页面的会话里，有多少个点了下载」。
 * 3. **自动化环境整体不上报**：`navigator.webdriver` 为 true 直接退出。
 *
 * **历史数据是 v1 口径，不能与 v2 相加或直接比较。** 分界日期 2026-11-15，
 * 跨这条线做趋势时要么只用一侧，要么在查询里按日期切开分别算。
 *
 * 用法：
 *   kTrack("download_click", { p: "hero" })
 *   kTrack("buy_click", { p: "pricing" })
 * 页面可见并停留够时长会自动上报一次 view；data-track 属性会自动绑定点击事件：
 *   <a href="..." data-track="download_click" data-track-page="hero">
 *   <button type="button" data-track="buy_click" data-track-page="pricing">
 */
(function () {
  var ENDPOINT = "https://kaidoplan-events.cygnusyang.top/t";
  var SITE = document.documentElement.getAttribute("data-site") || "kaidoplan";
  var LANG = (/^zh/i.test(document.documentElement.lang || "") ? "zh" : "en");

  // 页面可见后需停留多久才算一次浏览。1 秒足以滤掉「误点进来立刻退」，
  // 又短到不会漏掉真正在扫首屏的人。
  var VIEW_DWELL_MS = 1000;

  // 自动化浏览器不上报：无头 Chrome / Playwright 默认 navigator.webdriver 为 true。
  // 不设 Cookie 不代表不能识别这类访问，它们本来就不是「人看到页面」。
  var automated = false;
  try {
    automated = navigator.webdriver === true;
  } catch (e) {}
  if (automated) {
    window.kTrack = function () {};
    window.kRef = function () { return ""; };
    return;
  }

  // 来源标识：优先 utm_source，其次 ref，最后 referrer 的主机名。
  // 三者都只保留安全字符，避免把任意字符串写进数据库。
  function sourceTag() {
    try {
      var q = new URLSearchParams(location.search);
      var raw = q.get("utm_source") || q.get("ref") || "";
      if (!raw && document.referrer) {
        try {
          var host = new URL(document.referrer).hostname.replace(/^www\./, "");
          if (host && host !== location.hostname) raw = host;
        } catch (e) {}
      }
      return (raw || "").replace(/[^A-Za-z0-9_\-.]/g, "").slice(0, 60);
    } catch (e) {
      return "";
    }
  }

  var ref = "";
  try {
    // 同一次会话内记住来源：用户在页内跳转（pricing → hero）时不该丢掉归因。
    ref = sessionStorage.getItem("k_ref") || "";
    if (!ref) {
      ref = sourceTag();
      if (ref) sessionStorage.setItem("k_ref", ref);
    }
  } catch (e) {
    ref = sourceTag();
  }

  function pageName() {
    return location.pathname.replace(/^\/|\/$/g, "").replace(/\.html$/, "")
      .replace(/\//g, "-").replace(/^index$|^zh$/, "") || "home";
  }

  /**
   * 会话级去重：同一个 (事件名, 位置) 只放行一次。
   *
   * 走 sessionStorage 而不是内存，是因为用户在站内跳页会重新加载脚本，
   * 只放内存的话「home → pricing → home」会给首页记两次浏览。
   * 存不下（隐私模式、配额满）时退化为不去重——宁可多记，不要漏记。
   */
  function alreadySent(name, page) {
    try {
      var key = "k_ev:" + name + "|" + page;
      if (sessionStorage.getItem(key)) return true;
      sessionStorage.setItem(key, "1");
      return false;
    } catch (e) {
      return false;
    }
  }

  function kTrack(name, opts) {
    opts = opts || {};
    var page = (opts.p || "").replace(/[^A-Za-z0-9_\-.]/g, "").slice(0, 40);
    if (alreadySent(name, page)) return;
    var payload = JSON.stringify({
      n: name,
      s: SITE,
      r: ref,
      l: LANG,
      p: page
    });
    try {
      // keepalive：点下载会跳去 GitHub，普通 fetch 可能在导航时被取消。
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
        credentials: "omit"
      }).catch(function () {});
    } catch (e) {}
  }

  window.kTrack = kTrack;
  window.kRef = function () { return ref; };

  // ---- 浏览事件：可见 + 停留够时长 ----

  var viewSent = false;

  function sendView() {
    if (viewSent) return;
    viewSent = true;
    kTrack("view", { p: pageName() });
  }

  function isVisible() {
    try {
      return document.visibilityState !== "hidden";
    } catch (e) {
      return true;
    }
  }

  var dwellTimer = null;

  function startDwell() {
    if (dwellTimer || viewSent) return;
    dwellTimer = setTimeout(sendView, VIEW_DWELL_MS);
  }

  function stopDwell() {
    if (!dwellTimer) return;
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }

  function armView() {
    document.addEventListener("visibilitychange", function () {
      if (isVisible()) startDwell();
      else stopDwell();
    });
    if (isVisible()) startDwell();
  }

  function bindClicks() {
    var nodes = document.querySelectorAll("[data-track]");
    for (var i = 0; i < nodes.length; i++) {
      (function (el) {
        el.addEventListener("click", function () {
          // 停留不足 1 秒就点了下载：先把浏览补上，否则会出现「点击 > 浏览」。
          sendView();
          kTrack(el.getAttribute("data-track"), {
            p: el.getAttribute("data-track-page") || ""
          });
        });
      })(nodes[i]);
    }
  }

  function boot() {
    bindClicks();
    armView();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
