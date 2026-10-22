"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AutoGradeReview = api;
})(typeof window !== "undefined" ? window : this, function () {
  function groupQuestions(questions) {
    const urgent = [], errors = [], routine = [];
    questions.forEach((q, i) => {
      const entry = {q, i};
      if (!q.reviewed && (q.status === "uncertain" || q.judgment_pending)) urgent.push(entry);
      else if (q.status === "incorrect" || q.status === "blank") errors.push(entry);
      else routine.push(entry);
    });
    return {urgent, errors, routine};
  }
  function pendingAcceptance(questions) {
    const proposed = questions.filter(q => !q.reviewed && !q.judgment_pending);
    return {
      total: proposed.length,
      incorrect: proposed.filter(q => q.status === "incorrect").length,
      blank: proposed.filter(q => q.status === "blank").length
    };
  }
  function countStatus(entries) {
    return entries.reduce((totals, {q}) => {
      totals[q.status] = (totals[q.status] || 0) + 1;
      return totals;
    }, {});
  }
  return {groupQuestions, countStatus, pendingAcceptance};
});
