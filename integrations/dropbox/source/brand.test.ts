import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tools} from './catalog.ts';
import {successCard,failureCard} from './cards.ts';
import {DROPBOX_MARK} from './brand.ts';
test('every result success and failure has one inline Dropbox logo and no absolute mark bar',()=>{
 for(const tool of tools){
  const data='collection' in tool?{[tool.collection]:[]}:{name:'review.docx'};
  const cards=[successCard(tool,data,{path:'/QA/review.docx'}).blocks[0],failureCard(tool,'Request failed').blocks[0]];
  for(const card of cards){assert.ok(card.html.includes(DROPBOX_MARK),tool.name);assert.equal((card.html.match(/<span class="k-mk db-brand" data-k-mk>/g)||[]).length,1,tool.name);assert.doesNotMatch(card.html,/<div class="k-mkbar"/);assert.match(card.html,/alt="Dropbox"/);}
 }
});
test('success check belongs to the status group, separate from the Dropbox identity logo',()=>{
 const html=successCard(tools[0],{entries:[]},{path:''}).blocks[0].html;
 assert.match(html,/<header><span class="k-mk db-brand"/);
 assert.match(html,/<span class="db-state"><svg role="img" aria-label="Succeeded"/);
});
