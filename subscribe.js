/**
 * subscribe.js — 更新订阅表单。
 *
 * 与 resend.js 共用同一套「按 lang 切文案」的写法，避免中英两页各自漂移。
 *
 * 三个刻意的取舍：
 *
 * 1. **失败就说失败。** 不做「反正先弹个谢谢」——那会让用户以为订阅成功，
 *    然后永远收不到信，还查不出原因。
 *
 * 2. **只收邮箱 + 一个可选的工具选项。** 不问名字、不问公司、不问用途。
 *    多一个必填字段就少一半提交量，而这些信息在发信之后的点击里自然会暴露。
 *
 * 3. **提交成功后就地换成一句话，不跳页。** 跳页会让人怀疑「刚才到底提交了没」。
 */
(function () {
  var ENDPOINT = "https://kaido-license-service.cygnusyang.workers.dev/subscribe";

  var form = document.querySelector("[data-subscribe-form]");
  if (!form) return;

  var status = document.querySelector(".subscribe-status");
  var input = form.querySelector("input[name=email]");
  var button = form.querySelector("button");
  var zh = /^zh/i.test(document.documentElement.lang || "");

  var copy = {
    sending: zh ? "正在提交…" : "Submitting…",
    empty: zh ? "请输入邮箱。" : "Please enter your email.",
    ok: zh
      ? "订阅成功。有值得说的东西才发信，一两周一次。"
      : "You're on the list. I'll write when there's something worth saying — every week or two.",
    bad: zh ? "邮箱格式不正确，请检查。" : "That doesn't look like a valid email address.",
    limit: zh ? "请求过于频繁，请稍后再试。" : "Too many requests. Please try again a little later.",
    failed: zh
      ? "提交失败，请稍后重试。也可以直接发邮件给我。"
      : "Couldn't submit. Please try again, or just email me."
  };

  function setStatus(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.className = "subscribe-status" + (kind ? " is-" + kind : "");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = (input.value || "").trim();
    if (!email) {
      setStatus(copy.empty, "error");
      input.focus();
      return;
    }

    button.disabled = true;
    setStatus(copy.sending, "");

    var tool = form.querySelector("select[name=tool]");
    var payload = {
      email: email,
      tool: tool ? tool.value : "",
      lang: zh ? "zh" : "en",
      ref: window.kRef ? window.kRef() : ""
    };

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit"
    })
      .then(function (res) {
        return res.json().then(
          function (body) { return { status: res.status, body: body }; },
          function () { return { status: res.status, body: null }; }
        );
      })
      .then(function (r) {
        if (r.status === 200) {
          form.reset();
          setStatus(copy.ok, "ok");
          if (window.kTrack) window.kTrack("subscribe_submit", { p: "updates" });
        } else if (r.status === 400) {
          setStatus(copy.bad, "error");
          if (window.kTrack) window.kTrack("subscribe_fail", { p: "updates" });
        } else if (r.status === 429) {
          setStatus(copy.limit, "error");
          if (window.kTrack) window.kTrack("subscribe_fail", { p: "updates" });
        } else {
          setStatus(copy.failed, "error");
          if (window.kTrack) window.kTrack("subscribe_fail", { p: "updates" });
        }
      })
      .catch(function () {
        setStatus(copy.failed, "error");
        if (window.kTrack) window.kTrack("subscribe_fail", { p: "updates" });
      })
      .finally(function () {
        button.disabled = false;
      });
  });
})();
