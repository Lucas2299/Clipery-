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

/* Delete button on every row (your own videos only). */
(function () {
  var list = document.getElementById("job-list");
  if (!list) return;
  function decorate() {
    var rows = list.querySelectorAll(".job-row");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.querySelector(".job-del")) continue;
      var m = /\/(?:job\/|job=)([a-f0-9]+)/i.exec(row.getAttribute("href") || "");
      if (!m) continue;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "job-del";
      b.setAttribute("data-id", m[1]);
      b.title = "Delete this video and its clips";
      b.textContent = "Delete";
      var pill = row.querySelector(".status-pill");
      if (pill) row.insertBefore(b, pill);
      else row.appendChild(b);
    }
  }
  new MutationObserver(decorate).observe(list, { childList: true });
  decorate();
  list.addEventListener("click", async function (ev) {
    var b = ev.target.closest ? ev.target.closest(".job-del") : null;
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!confirm("Delete this video and all its clips? This cannot be undone.")) return;
    b.disabled = true;
    b.textContent = "Deleting...";
    try {
      var res = await fetch("/api/clip/" + encodeURIComponent(b.getAttribute("data-id")), { method: "DELETE" });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not delete.");
      var row = b.closest(".job-row");
      if (row) row.remove();
    } catch (e) {
      alert(e.message);
      b.disabled = false;
      b.textContent = "Delete";
    }
  });
})();
