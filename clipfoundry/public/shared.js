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
      scoring_sources: "Scoring each video",
      downloading: "Downloading links",
      rendering: "Rendering vertical clips",
      rendering_clips: "Rendering ranked clips",
      building_compilation: "Building countdown ranking video",
      complete: "Done",
      processing: "Processing",
    };
    return map[stage] || stage || "Working…";
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
      " → " +
      formatTime(c.end) +
      " · " +
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
            ? formatTime(r.start) + "–" + formatTime(r.end)
            : r.sourceUrl
              ? "link"
              : "—";
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
          (r.duration != null ? r.duration + "s" : "—") +
          "</td>" +
          "<td>" +
          (r.dimensions
            ? "H" +
              r.dimensions.hook +
              " · E" +
              r.dimensions.pacing +
              " · R" +
              r.dimensions.retention
            : "—") +
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

  // Boot common chrome
  document.addEventListener("DOMContentLoaded", function () {
    setActiveNav();
    yearStamp();
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
  };
})(window);
