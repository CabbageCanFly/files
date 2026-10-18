let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let j = {};
  try { j = JSON.parse(raw); } catch (e) {}
  const parts = [];
  const fmtDate = (s) => {
    const d = new Date(s * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const model = j.model && j.model.display_name;
  const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  if (model) parts.push(c("1;36", model) + (j.effort && j.effort.level ? c("35", ` (${j.effort.level})`) : ""));
  const dir = (j.workspace && j.workspace.current_dir) || j.cwd;
  if (dir) parts.push(c("34", dir));
  const cw = j.context_window || {};
  if (cw.used_percentage != null) {
    const u = Math.round(cw.used_percentage);
    parts.push(c(u >= 80 ? "31" : u >= 50 ? "33" : "32", `ctx ${u}%`));
  }
  const rl = j.rate_limits || {};
  for (const [key, label, col, rcol] of [["five_hour", "5h", "92", "96"], ["seven_day", "7d", "95", "93"]]) {
    const w = rl[key];
    if (w && w.used_percentage != null) {
      let s = c(col, `${label} ${Math.round(100 - w.used_percentage)}% left`);
      if (w.resets_at) s += " " + c(rcol, `(resets ${fmtDate(w.resets_at)})`);
      parts.push(s);
    }
  }
  if (cw.total_input_tokens != null) parts.push(c("94", `in ${cw.total_input_tokens}`));
  if (cw.total_output_tokens != null) parts.push(c("91", `out ${cw.total_output_tokens}`));
  process.stdout.write(parts.join(c("90", " | ")));
});
