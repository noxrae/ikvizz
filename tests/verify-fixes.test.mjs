import { io } from 'socket.io-client';
const BASE='http://localhost:4321';
const login=async u=>(await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'aether123'})})).json()).token;
const authed=(t,p,o={})=>fetch(BASE+'/api'+p,{method:o.method||(o.body?'POST':'GET'),headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:o.body?JSON.stringify(o.body):undefined}).then(x=>x.json().catch(()=>({})));
const tokA=await login('aarav');
const a=io(BASE,{auth:{token:tokA}}); await new Promise(x=>a.on('connect',x));
a.emit('conversation:join',1); await new Promise(x=>setTimeout(x,150));
let pass=0,tot=0; const ok=(n,c)=>{tot++;if(c)pass++;console.log((c?'PASS':'FAIL')+'  '+n)};
// capsule edit-leak: create locked capsule, try to edit → must be refused
const cap=await authed(tokA,'/conversations/1/messages',{body:{body:'secret',unlockAt:Date.now()+3600000}});
const ed=await new Promise(res=>a.emit('message:edit',{messageId:cap.message.id,body:'LEAK ATTEMPT'},res));
ok('capsule edit refused', ed?.ok===false);
// poll edit refused
const poll=await authed(tokA,'/conversations/1/messages',{body:{body:'best?',pollOptions:['x','y']}});
const pe=await new Promise(res=>a.emit('message:edit',{messageId:poll.message.id,body:'nope'},res));
ok('poll edit refused', pe?.ok===false);
// edit preserves mood signal (result arrives via the message:edited broadcast)
const mm=await authed(tokA,'/conversations/1/messages',{body:{body:'yay',mood:'love'}});
const editedSeen=new Promise(res=>a.once('message:edited',d=>res(d)));
a.emit('message:edit',{messageId:mm.message.id,body:'yay fixed'});
const ev=await Promise.race([editedSeen,new Promise(res=>setTimeout(()=>res(null),1500))]);
ok('edit preserves mood signal', ev?.message?.signals?.some(s=>s.type==='mood'&&s.kind==='love'));
a.close();
console.log(pass+'/'+tot);
process.exit(0);
