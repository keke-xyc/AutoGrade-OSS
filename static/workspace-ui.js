"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AutoGradeWorkspace = api;
})(typeof window !== "undefined" ? window : this, function () {
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
  const busyStates = new Set(["queued", "processing", "feedback_queued", "feedbacking", "cropping", "locating", "judging"]);

  function filters({student = "", start = "", end = ""} = {}) {
    const dateActive = Boolean(start || end);
    const count = Number(Boolean(student)) + Number(dateActive);
    return {applied: count > 0, count, dateActive};
  }
  function uploadSummary({count = 0, studentName = "", day = "", uploading = false, submission = false} = {}) {
    if (uploading) return {title: "正在上传照片", detail: "提交处理中，请保持页面打开并等待受理结果。"};
    if (submission) return {title: "提交结果待确认", detail: "请先检查上次提交是否已被受理，避免重复计费。"};
    if (!count) return {title: "等待选择照片", detail: "先选择学生和作业照片，再提交批改。"};
    return {
      title: `已选择 ${count} 张作业照片`,
      detail: `${studentName || "请选择学生"} · ${day || "请选择日期"} · 提交前核对照片顺序`
    };
  }
  function jobCard(job, labels = {}) {
    const status = String(job.status ?? "");
    const progress = busyStates.has(status);
    const action = status === "confirmed" ? "查看已归档作业" :
      progress ? "查看批改进度" : status === "failed" ? "查看失败原因" : "继续复核";
    const hint = status === "review" ? "需要老师确认题目和回复" :
      status === "confirmed" ? "回复与批改记录已保存" :
      progress ? "任务已受理，可稍后再查看" : "检查处理状态并决定是否重试";
    const name = String(job.student_name ?? "");
    const grade = String(job.grade ?? "");
    const day = String(job.day ?? "");
    return `<article class="job-card"><div class="job-card-head"><span class="avatar">${escapeHTML(name.slice(0, 1))}</span><div class="job-identity"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(grade)} · ${escapeHTML(day)}</small></div><span class="badge ${escapeHTML(status)}">${escapeHTML(labels[status] || status)}</span></div><p class="job-card-hint">${hint}</p>${job.error ? `<p class="error-text">${escapeHTML(job.error)}</p>` : ""}<div class="job-card-footer"><span>${Number(job.pages) || 0}张照片</span><a href="#review/${encodeURIComponent(String(job.id ?? ""))}" aria-label="${escapeHTML(name)}：${action}">${action} <span aria-hidden="true">→</span></a></div></article>`;
  }
  function emptyList({filter = "pending", hasConstraints = false} = {}) {
    if (hasConstraints) return '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">⌕</div><h3>没有符合筛选条件的作业</h3><p class="muted">可以清除条件，查看其他日期或学生的作业。</p><button type="button" class="button secondary" data-clear-job-filters>清除筛选并查看全部</button></div>';
    const confirmed = filter === "confirmed";
    return `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">▧</div><h3>${confirmed ? "还没有已确认的作业" : "这里暂时没有待处理的作业"}</h3><p class="muted">${confirmed ? "复核、确认后，作业与家长回复会保存在这里。" : "导入孩子的作业照片，开始准备第一份批改。"}</p><a href="#upload" class="button secondary">＋ 导入一份作业</a></div>`;
  }
  return {filters, uploadSummary, jobCard, emptyList};
});
