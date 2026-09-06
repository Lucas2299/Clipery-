/* Promo board: paid members post their channels once a week; Studio first, then Pro, then Starter. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var y = $("year");
  if (y) y.textContent = new Date().getFullYear();

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function msg(text, err) {
    var el = $("pr-msg");
    el.textContent = text || "";
    el.style.color = err ? "#ff6b6b" : "#7ee2a8";
  }
  function handleOf(url) {
    try {
      var u = new URL(url);
      var seg = u.pathname.split("/").filter(Boolean);
      var last = seg[seg.length - 1] || u.hostname;
      return decodeURIComponent(last).replace(/^@/, "");
    } catch (_) { return url; }
  }
  var PLAN_NAME = { studio: "Studio", pro: "Pro", starter: "Starter" };

  function cardHtml(p) {
    var links = [];
    if (p.youtube) links.push('<a class="promo-link yt" href="' + esc(p.youtube) + '" target="_blank" rel="noopener nofollow">YouTube <span>@' + esc(handleOf(p.youtube)) + "</span></a>");
    if (p.tiktok) links.push('<a class="promo-link tt" href="' + esc(p.tiktok) + '" target="_blank" rel="noopener nofollow">TikTok <span>@' + esc(handleOf(p.tiktok)) + "</span></a>");
    if (p.instagram) links.push('<a class="promo-link ig" href="' + esc(p.instagram) + '" target="_blank" rel="noopener nofollow">Instagram <span>@' + esc(handleOf(p.instagram)) + "</span></a>");
    return (
      '<article class="promo-card tier-' + esc(p.plan) + (p.mine ? " mine" : "") + '" data-id="' + esc(p.id) + '">' +
        '<div class="promo-top">' +
          '<span class="pill ' + esc(p.plan) + '">' + esc(PLAN_NAME[p.plan] || p.plan) + "</span>" +
          (p.mine ? '<button type="button" class="mini ghost" data-del>Remove</button>' : "") +
        "</div>" +
        "<h3>" + esc(p.name) + "</h3>" +
        (p.tagline ? "<p>" + esc(p.tagline) + "</p>" : "") +
        '<div class="promo-links">' + links.join("") + "</div>" +
      "</article>"
    );
  }

  function render(d) {
    var board = $("promo-board");
    var rows = d.promos || [];
    $("promo-empty").hidden = rows.length > 0;
    var html = "";
    var tiers = [["studio", "Studio creators"], ["pro", "Pro creators"], ["starter", "Starter creators"]];
    tiers.forEach(function (t) {
      var group = rows.filter(function (p) { return p.plan === t[0]; });
      if (!group.length) return;
      html += '<h2 class="promo-tier-h ' + t[0] + '">' + t[1] + " <small>" + group.length + "</small></h2>";
      html += '<div class="promo-grid">' + group.map(cardHtml).join("") + "</div>";
    });
    board.querySelectorAll(".promo-tier-h, .promo-grid").forEach(function (n) { n.remove(); });
    board.insertAdjacentHTML("beforeend", html);

    var me = d.me;
    var gate = $("promo-gate");
    var form = $("promo-form");
    var pill = $("promo-plan-pill");
    if (!me) {
      gate.innerHTML = 'Log in with a paid plan to post your channels. <a href="/login?next=/promo">Log in</a>';
      form.hidden = true;
      return;
    }
    pill.hidden = false;
    pill.className = "pill " + me.plan;
    pill.textContent = me.planLabel + " plan";
    if (!me.canPost) {
      gate.innerHTML = "The promo board is for paid plans. <a href=\"/pricing\">Upgrade</a> to Starter, Pro or Studio to post your channels.";
      form.hidden = true;
      return;
    }
    form.hidden = false;
    if (!$("pr-name").value) $("pr-name").value = me.name || "";
    var mine = rows.filter(function (p) { return p.mine; })[0];
    if (mine) {
      $("pr-name").value = mine.name || "";
      $("pr-tagline").value = mine.tagline || "";
      $("pr-youtube").value = mine.youtube || "";
      $("pr-tiktok").value = mine.tiktok || "";
      $("pr-instagram").value = mine.instagram || "";
    }
    if (me.nextAllowedAt) {
      var days = Math.ceil((me.nextAllowedAt - Date.now()) / 86400000);
      gate.textContent = "Your card is live. You can post again in " + days + " day" + (days === 1 ? "" : "s") + ".";
      $("pr-submit").disabled = true;
    } else {
      gate.textContent = me.plan === "studio"
        ? "Studio accounts are shown at the very top of the board."
        : me.plan === "pro" ? "Pro accounts are shown right under Studio." : "Starter accounts are listed after Studio and Pro.";
      $("pr-submit").disabled = false;
    }
  }

  async function load() {
    var res = await fetch("/api/promo");
    var d = await res.json().catch(function () { return {}; });
    render(d);
  }

  $("promo-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    msg("");
    var btn = $("pr-submit");
    btn.disabled = true;
    var res = await fetch("/api/promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("pr-name").value,
        tagline: $("pr-tagline").value,
        youtube: $("pr-youtube").value,
        tiktok: $("pr-tiktok").value,
        instagram: $("pr-instagram").value,
      }),
    });
    var d = await res.json().catch(function () { return {}; });
    if (!res.ok || !d.ok) {
      msg(d.error || "Could not post.", true);
      btn.disabled = false;
      return;
    }
    msg("Posted. You are on the board.");
    load();
  });

  $("promo-board").addEventListener("click", async function (e) {
    if (!e.target.hasAttribute("data-del")) return;
    var card = e.target.closest(".promo-card");
    if (!card || !confirm("Remove your card from the board?")) return;
    await fetch("/api/promo/" + card.getAttribute("data-id"), { method: "DELETE" });
    load();
  });

  load();
})();
