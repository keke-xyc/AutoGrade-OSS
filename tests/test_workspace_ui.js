"use strict";
const assert = require("node:assert/strict");
const Workspace = require("../static/workspace-ui.js");
assert.deepEqual(Workspace.filters(),{applied:false,count:0,dateActive:false});
assert.deepEqual(Workspace.filters({student:"one",start:"2026-10-01",end:"2026-10-31"}),{applied:true,count:2,dateActive:true});
assert.deepEqual(Workspace.filters({end:"2026-10-31"}),{applied:true,count:1,dateActive:true});
assert.deepEqual(Workspace.uploadSummary({}),{title:"等待选择照片",detail:"先选择学生和作业照片，再提交批改。"});
assert.match(Workspace.uploadSummary({count:2,studentName:"小明",day:"2026-10-18"}).detail,/小明 · 2026-10-18/);
assert.equal(Workspace.uploadSummary({count:2,uploading:true}).title,"正在上传照片");
assert.equal(Workspace.uploadSummary({count:2,submission:true}).title,"提交结果待确认");
const html=Workspace.jobCard({
  id:'q"# /<&',student_name:'<img src=x onerror=alert(1)>',grade:'四"<年',
  day:'2026-10-18',pages:2,status:'review',error:'<script>bad()</script>'
},{review:"待复核"});
assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
assert.doesNotMatch(html,/<script|<img src=x|onerror="alert/);
assert.match(html,/href="#review\/q%22%23%20%2F%3C%26"/);
assert.match(html,/继续复核/);
assert.match(Workspace.jobCard({status:"processing",student_name:"小明",id:"job",pages:1}),/查看批改进度/);
assert.match(Workspace.jobCard({status:"confirmed",student_name:"小明",id:"job",pages:1}),/查看已归档作业/);
assert.match(Workspace.jobCard({status:"failed",student_name:"小明",id:"job",pages:1}),/查看失败原因/);
assert.match(Workspace.emptyList({filter:"confirmed"}),/还没有已确认的作业/);
assert.match(Workspace.emptyList({hasConstraints:true}),/data-clear-job-filters/);
assert.doesNotMatch(Workspace.emptyList({hasConstraints:true}),/href="#upload"/);
console.log("Workspace view-model grouping, safe rendering and empty states: PASS");
