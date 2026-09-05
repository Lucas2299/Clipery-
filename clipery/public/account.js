/* Account page: plan + videos left, rename, change password, log out. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var y = $("year");
  if (y) y.textContent = new Date().getFullYear();

  function msg(id, text, err) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.style.color = err ? "#ff6b6b" : "#7ee2a8";
  }

  async function load() {
    var res = await fetch("/api/auth/me");
    var d = await res.json().catch(function () { return {}; });
    if (!d || !d.user) { location.href = "/login?next=/account"; return; }
    var u = d.user;
    $("acct-email").textContent = u.email;
    $("acct-name").value = u.name || "";
    $("acct-plan").textContent = u.planLabel || "Free";
    $("acct-plan-detail").textContent =
      (u.videosTotal == null ? "Unlimited videos" : u.videosTotal + " videos a month") +
      " - up to " + u.maxMinutes + " min each - " + u.maxClipsPerVideo + " clips per video";
    if (u.videosTotal == null) {
      $("acct-left").textContent = "Unlimited";
      $("acct-fill").style.width = "100%";
      $("acct-usage-note").textContent = "";
    } else {
      var left = u.videosLeft == null ? 0 : u.videosLeft;
      $("acct-left").textContent = left + " of " + u.videosTotal;
      $("acct-fill").style.width = Math.round((left / Math.max(1, u.videosTotal)) * 100) + "%";
      $("acct-usage-note").textContent = left === 0
        ? "You have used all your videos this month. Change plan to get more, or wait for next month."
        : "Videos reset at the start of every month. Failed jobs never count.";
    }
    var social = !(u.providers || []).includes("password");
    $("pw-form").hidden = social;
    $("pw-social").hidden = !social;
  }

  $("name-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    msg("name-msg", "");
    var res = await fetch("/api/auth/profile", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("acct-name").value }) });
    var d = await res.json().catch(function () { return {}; });
    if (!res.ok || !d.ok) return msg("name-msg", d.error || "Could not save.", true);
    msg("name-msg", "Saved.");
  });

  $("pw-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    msg("pw-msg", "");
    var res = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: $("pw-current").value, next: $("pw-next").value }) });
    var d = await res.json().catch(function () { return {}; });
    if (!res.ok || !d.ok) return msg("pw-msg", d.error || "Could not change password.", true);
    $("pw-current").value = "";
    $("pw-next").value = "";
    msg("pw-msg", "Password changed.");
  });

  $("acct-logout").addEventListener("click", async function () {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) {}
    location.href = "/";
  });

  load().catch(function () { location.href = "/login?next=/account"; });
})();
