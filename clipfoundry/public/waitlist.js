(function () {
  const CF = window.CF;
  const form = CF.$("#waitlist-form");
  const formMsg = CF.$("#form-msg");
  const submitBtn = CF.$("#submit-btn");
  const countEl = CF.$("#waitlist-count");
  const success = CF.$("#form-success");
  const successText = CF.$("#success-text");
  const positionBadge = CF.$("#position-badge");

  async function refreshCount() {
    try {
      const { data } = await CF.api("/api/waitlist");
      if (countEl && data && typeof data.count === "number") {
        countEl.textContent = String(data.count);
      }
    } catch (_) {}
  }
  refreshCount();

  if (!form) return;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    formMsg.textContent = "";
    formMsg.className = "form-msg";
    const email = (form.email.value || "").trim();
    const name = (form.name.value || "").trim();
    const role = form.role.value;
    const interest = form.interest.value;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      formMsg.textContent = "Please enter a valid email.";
      formMsg.classList.add("error");
      return;
    }
    submitBtn.disabled = true;
    const prev = submitBtn.textContent;
    submitBtn.textContent = "Joining…";
    try {
      const { res, data } = await CF.api("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, role, interest, source: "waitlist-page" }),
      });
      if (!res.ok || !data || !data.ok) {
        formMsg.textContent = (data && data.error) || "Something went wrong.";
        formMsg.classList.add("error");
        submitBtn.disabled = false;
        submitBtn.textContent = prev;
        return;
      }
      form.classList.add("hide");
      success.classList.add("show");
      positionBadge.textContent = "#" + data.position;
      successText.textContent = data.already
        ? "You were already on the list — original spot kept."
        : "We’ll email you when your early-access seat opens.";
      if (countEl) countEl.textContent = String(data.count);
    } catch (_) {
      formMsg.textContent = "Network error.";
      formMsg.classList.add("error");
      submitBtn.disabled = false;
      submitBtn.textContent = prev;
    }
  });
})();
