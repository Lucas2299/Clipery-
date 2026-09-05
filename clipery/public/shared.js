/* Clipery shared client utilities */
(function (global) {
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function stageLabel(stage) {
    const map = {
      queued: "Queued",
      probing: "Reading video",
      detecting_moments: "Detecting moments",
      scoring: "Scoring clips",
      listening: "Listening to the audio",
      watching: "Watching the picture",
      checking_context: "Checking context and payoff",
      scoring_sources: "Scoring each video",
      downloading: "Downloading links",
      rendering: "Rendering vertical clips",
      rendering_clips: "Rendering ranked clips",
      building_compilation: "Building countdown ranking video",
      complete: "Done",
      processing: "Processing",
    };
    return map[stage] || stage || "Working...";
  }

  function setActiveNav() {
    const path = location.pathname.replace(/\.html$/, "") || "/";
    $all("[data-nav]").forEach(function (a) {
      const href = a.getAttribute("href") || "";
      const clean = href.replace(/\.html$/, "");
      const match =
        clean === path ||
        (clean !== "/" && path.startsWith(clean)) ||
        (clean === "/studio" && path.startsWith("/job"));
      a.classList.toggle("active", match);
    });
  }

  function yearStamp() {
    const el = $("#year");
    if (el) el.textContent = String(new Date().getFullYear());
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { res, data };
  }

  function dimBars(dimensions) {
    if (!dimensions) return "";
    const keys = [
      ["hook", "Hook"],
      ["pacing", "Energy"],
      ["retention", "Retain"],
      ["length", "Length"],
    ];
    return (
      '<div class="dim-bars">' +
      keys
        .map(function (pair) {
          const k = pair[0];
          const label = pair[1];
          const v = Math.min(100, Math.max(0, Number(dimensions[k]) || 0));
          return (
            '<div class="dim-row"><span>' +
            label +
            '</span><div class="dim-track"><div class="dim-fill" style="width:' +
            v +
            '%"></div></div><b>' +
            v +
            "</b></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderClipCard(c) {
    return (
      '<article class="clip-card">' +
      '<video src="' +
      escapeHtml(c.url) +
      '" controls playsinline preload="metadata"></video>' +
      '<div class="clip-card-body">' +
      '<div class="clip-card-top">' +
      '<span class="clip-rank-pill">#' +
      c.rank +
      "</span>" +
      '<span class="clip-score-pill">' +
      c.score +
      " score</span>" +
      "</div>" +
      "<h4>" +
      escapeHtml(c.title) +
      "</h4>" +
      '<div class="meta">' +
      formatTime(c.start) +
      " -> " +
      formatTime(c.end) +
      " - " +
      c.duration +
      "s</div>" +
      dimBars(c.dimensions) +
      '<div class="clip-actions">' +
      '<a href="' +
      escapeHtml(c.url) +
      '" download="' +
      escapeHtml(c.downloadName || "clip.mp4") +
      '">Download</a>' +
      '<a href="' +
      escapeHtml(c.url) +
      '" target="_blank" rel="noopener">Open</a>' +
      "</div></div></article>"
    );
  }

  function renderRankTable(rankings) {
    if (!rankings || !rankings.length) return "";
    const rows = rankings
      .map(function (r) {
        const timeCell =
          r.start != null && r.end != null
            ? formatTime(r.start) + "-" + formatTime(r.end)
            : r.sourceUrl
              ? "link"
              : "-";
        return (
          "<tr>" +
          "<td><strong>#" +
          r.rank +
          "</strong></td>" +
          '<td class="score-cell">' +
          r.score +
          "</td>" +
          "<td>" +
          escapeHtml(r.title) +
          "</td>" +
          "<td>" +
          timeCell +
          "</td>" +
          "<td>" +
          (r.duration != null ? r.duration + "s" : "-") +
          "</td>" +
          "<td>" +
          (r.dimensions
            ? "H" +
              r.dimensions.hook +
              " - E" +
              r.dimensions.pacing +
              " - R" +
              r.dimensions.retention
            : "-") +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    return (
      '<div class="rank-table-wrap"><table class="rank-table"><thead><tr>' +
      "<th>Rank</th><th>Score</th><th>Title</th><th>Time</th><th>Len</th><th>Breakdown</th>" +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table></div>"
    );
  }

  function createPoller(jobId, hooks) {
    let timer = null;
    const stop = function () {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const tick = async function () {
      try {
        const { res, data } = await api("/api/clip/status/" + jobId);
        if (!res.ok || !data || !data.ok) {
          if (hooks.onError) hooks.onError((data && data.error) || "Status failed");
          stop();
          return;
        }
        const job = data.job;
        if (hooks.onUpdate) hooks.onUpdate(job);
        if (job.status === "done") {
          if (hooks.onDone) hooks.onDone(job);
          stop();
        } else if (job.status === "error") {
          if (hooks.onError) hooks.onError(job.error || "Job failed");
          stop();
        }
      } catch (e) {
        if (hooks.onError) hooks.onError("Network error while polling");
        stop();
      }
    };
    tick();
    timer = setInterval(tick, 1100);
    return { stop };
  }

  /* ------------------------------ account chip ------------------------------ */
  var currentUser = null;

  async function loadUser() {
    try {
      var res = await fetch("/api/auth/me", { headers: { Accept: "application/json" } });
      var data = await res.json();
      currentUser = (data && data.user) || null;
    } catch {
      currentUser = null;
    }
    return currentUser;
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    location.href = "/";
  }

  /** Drop a "you are logged in as..." chip (or Log in button) into the nav. */
  function renderAccountChip(user) {
    var nav = document.querySelector(".nav") || document.querySelector(".nav-links");
    if (!nav || nav.querySelector("[data-account]")) return;

    var wrap = document.createElement("span");
    wrap.setAttribute("data-account", "");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:0.55rem;margin-left:0.4rem";

    if (user && user.isOwner) {
      var dash = document.createElement("a");
      dash.href = "/admin";
      dash.textContent = "Dashboard";
      dash.style.cssText = "font-size:0.82rem;font-weight:800;color:#ff8a4c;text-decoration:none";
      wrap.appendChild(dash);
    }
    if (user) {
      var who = document.createElement("a");
      who.href = "/account";
      who.textContent = user.name || user.email;
      who.title = "Account settings (" + user.email + ")";
      who.style.cssText =
        "font-size:0.82rem;font-weight:700;color:#c9c5d8;max-width:150px;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;text-decoration:none";
      var out = document.createElement("button");
      out.type = "button";
      out.textContent = "Log out";
      out.style.cssText =
        "font-family:inherit;font-size:0.8rem;font-weight:700;cursor:pointer;color:#f4f1ea;" +
        "background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:999px;padding:0.35rem 0.8rem";
      out.addEventListener("click", logout);
      wrap.appendChild(who);
      wrap.appendChild(out);
    } else {
      var login = document.createElement("a");
      login.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
      login.textContent = "Log in";
      login.className = "btn btn-primary btn-sm";
      wrap.appendChild(login);
    }
    nav.appendChild(wrap);
  }

  /** Tell the member what their plan allows, right above the upload box. */
  function renderPlanNote(user) {
    if (!user) return;
    var host = document.querySelector(".studio-page-head") || document.querySelector(".studio-shell");
    if (!host || document.getElementById("plan-note")) return;

    var note = document.createElement("p");
    note.id = "plan-note";
    note.style.cssText =
      "margin:-.3rem 0 1.1rem;font-size:.85rem;color:#9894a6;background:rgba(255,255,255,.04);" +
      "border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:.6rem .85rem";

    var left = user.videosLeft;
    if (left === 0) {
      note.style.borderColor = "rgba(255,77,109,.45)";
      note.style.color = "#ffb3c1";
      note.innerHTML =
        "<b style='color:#fff'>" + escapeHtml(user.planLabel) + " plan:</b> no videos left this month. " +
        "<a href='/pricing' style='color:#ff8a4c;font-weight:700;text-decoration:none'>See plans</a>";
    } else {
      note.innerHTML =
        "<b style='color:#f4f1ea'>" + escapeHtml(user.planLabel) + " plan:</b> " +
        (left === null ? "unlimited videos" : left + " video" + (left === 1 ? "" : "s") + " left this month") +
        " &middot; up to " + user.maxMinutes + " min per video" +
        " &middot; " + user.maxClipsPerVideo + " clips per video";
    }
    host.parentNode.insertBefore(note, host.nextSibling);
  }

  // Boot common chrome
  document.addEventListener("DOMContentLoaded", function () {
    setActiveNav();
    yearStamp();
    if (!/^\/login|^\/register/.test(location.pathname)) {
      loadUser().then(function (user) {
        renderAccountChip(user);
        renderPlanNote(user);
      });
    }
  });

  global.CF = {
    $,
    $all,
    escapeHtml,
    formatTime,
    formatDate,
    stageLabel,
    api,
    dimBars,
    renderClipCard,
    renderRankTable,
    createPoller,
    loadUser,
    logout,
    getUser: function () { return currentUser; },
  };
})(window);
