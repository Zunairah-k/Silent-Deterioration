const { spawn } = require('child_process');
const server = spawn('node', ['dist/index.js'], { stdio: ['pipe','pipe','inherit'] });
let buf = '';
server.stdout.on('data', d => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  lines.forEach(line => { 
  try { 
    const parsed = JSON.parse(line);
    // Pretty print the actual tool content
    if (parsed.result?.content?.[0]?.text) {
      console.log(`\n=== Response id:${parsed.id} ===`);
      console.log(JSON.parse(parsed.result.content[0].text));
    } else {
      console.log(parsed);
    }
  } catch{} 
});
});
const send = (msg) => server.stdin.write(JSON.stringify(msg) + '\n');
setTimeout(() => send({ jsonrpc:'2.0', id:1, method:'initialize',
  params:{ protocolVersion:'2024-11-05', capabilities:{},
  clientInfo:{name:'test',version:'1.0'} }}), 200);
setTimeout(() => send({ jsonrpc:'2.0', id:2, method:'tools/list', params:{} }), 800);
setTimeout(() => send({ jsonrpc:'2.0', id:3, method:'tools/call',
  params:{ name:'get_patient_vitals', arguments:{ patientId:'592011' } }}), 1500);
setTimeout(() => send({ jsonrpc:'2.0', id:4, method:'tools/call',
  params:{ name:'assess_deterioration_risk',
  arguments:{ patientId:'592011', includeRecommendations:true } }}), 3000);
setTimeout(() => send({ jsonrpc:'2.0', id:5, method:'tools/call',
  params:{ name:'scan_ward_for_deterioration',
  arguments:{ patientIds:['592011','592012','592013'] } }}), 6000);
setTimeout(() => { console.log('\n✅ All tools tested!'); server.kill(); }, 12000);