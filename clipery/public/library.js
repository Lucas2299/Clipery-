(function () {
  const CF = window.CF;
  const list = CF.$("#job-list");
  const btn = CF.$("#btn-refresh");

  async function load() {
    if (!list) return;
    list.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { res, data } = await CF.api("/api/jobs");
      if (!res.ok || !data || !data.ok) {
        list.innerHTML = '<div class="empty error-text">Could not load jobs.</div>';
        return;
      }
      if (!data.jobs.length) {
        list.innerHTML =
          '<div class="empty">No jobs yet. <a href="/studio" style="color:var(--accent-2);font-weight:600">Open studio</a> to create your first clips.</div>';
        return;
      }
      list.innerHTML = data.jobs
        .map(function (j) {
          const st = j.status || "unknown";
          return (
            '<a class="job-row" href="' +
            (st === "review" ? "/studio?tool=editor&job=" + j.id : "/job/" + j.id) +
            '">' +
            "<div><h3>" +
            CF.escapeHtml(j.sourceName || "Video") +
            "</h3>" +
            '<p class="dim">' +
            CF.formatDate(j.createdAt) +
            " · " +
            CF.escapeHtml(j.mode || "viral") +
            (j.duration ? " · " + Math.round(j.duration) + "s source" : "") +
            (j.clipCount ? " · " + j.clipCount + " clips" : "") +
            "</p></div>" +
            '<span class="status-pill ' +
            CF.escapeHtml(st) +
            '">' +
            CF.escapeHtml(st) +
            "</span>" +
            '<span class="score-cell">' +
            (j.topScore != null ? j.topScore : "—") +
            "</span>" +
            "</a>"
          );
        })
        .join("");
    } catch (_) {
      list.innerHTML = '<div class="empty error-text">Network error.</div>';
    }
  }

  if (btn) btn.addEventListener("click", load);
  load();
  // auto-refresh if any processing
  setInterval(async function () {
    try {
      const { data } = await CF.api("/api/jobs");
      if (!data || !data.ok) return;
      const busy = data.jobs.some(function (j) {
        return j.status === "processing" || j.status === "queued";
      });
      if (busy) load();
    } catch (_) {}
  }, 4000);
})();
