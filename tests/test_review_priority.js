"use strict";
const assert = require("node:assert/strict");
const {groupQuestions, countStatus} = require("../static/review-priority.js");
const questions = [
  {id:"ok",status:"correct",reviewed:false},
  {id:"wrong",status:"incorrect",reviewed:false},
  {id:"unknown",status:"uncertain",reviewed:false},
  {id:"blank",status:"blank",reviewed:false},
  {id:"edited",status:"correct",reviewed:false,judgment_pending:true},
  {id:"acknowledged",status:"uncertain",reviewed:true},
  {id:"fixed-wrong",status:"incorrect",reviewed:true}
];
const groups=groupQuestions(questions);
assert.deepEqual(groups.urgent.map(x=>x.q.id),["unknown","edited"]);
assert.deepEqual(groups.errors.map(x=>x.q.id),["wrong","blank","fixed-wrong"]);
assert.deepEqual(groups.routine.map(x=>x.q.id),["ok","acknowledged"]);
assert.deepEqual(groups.urgent.map(x=>x.i),[2,4],"keep stable question indices");
assert.deepEqual(countStatus(groups.errors),{incorrect:2,blank:1});
assert.deepEqual(require("../static/review-priority.js").pendingAcceptance(questions),{total:4,incorrect:1,blank:1});
assert.deepEqual(require("../static/review-priority.js").pendingAcceptance([{status:"incorrect",reviewed:true},{status:"blank",reviewed:false,judgment_pending:true}]),{total:0,incorrect:0,blank:0});
assert.deepEqual(groupQuestions([]),{urgent:[],errors:[],routine:[]});
assert.deepEqual(questions.map(x=>x.id),["ok","wrong","unknown","blank","edited","acknowledged","fixed-wrong"],"do not mutate grading records");
console.log("Review priority grouping: PASS");
