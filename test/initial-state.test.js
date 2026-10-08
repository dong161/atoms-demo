import http from 'node:http';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {engineerBuild} from '../server/agents.js';
test('创建与修改提示词禁止伪造初始统计，保留演示标识',async()=>{
let prompts=[];const s=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;prompts.push(JSON.parse(b).messages[0].content);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'<!DOCTYPE html><html><head><title>x</title></head><body><script>1</script></body></html>'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});await new Promise(r=>s.listen(0,'127.0.0.1',r));
try{const cfg={baseUrl:`http://127.0.0.1:${s.address().port}`,mockOnly:false};for(const mode of ['create','edit'])await engineerBuild({cfg,model:'fixture',mode,plan:{title:'喝水',features:['点击增加250ml']},prompt:'喝水打卡',baseHtml:'<html><script>1</script></html>',instruction:'换蓝色'});for(const p of prompts){assert.ok(!p.includes('首次打开要有 2-3 条示例数据'));assert.ok(p.includes('必须从 0 或空记录开始'));assert.ok(p.includes('明确标为演示'));assert.ok(p.includes('不得重置或污染已保存的用户数据'));}}finally{s.close();}

});
