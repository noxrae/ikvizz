import { io } from 'socket.io-client';
const BASE='http://localhost:4321';
const login=async u=>(await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'aether123'})})).json()).token;
const tokA=await login('aarav');
const a=io(BASE,{auth:{token:tokA}}); await new Promise(x=>a.on('connect',x));
a.emit('conversation:join',1); await new Promise(x=>setTimeout(x,150));
// react with a NEW neon kind on message id 1
const r=await new Promise(res=>a.emit('reaction:toggle',{messageId:1,kind:'skull'},res));
console.log(r?.ok ? 'PASS  neon reaction (skull) accepted server-side' : 'FAIL  '+(r?.error||'no ack'));
const r2=await new Promise(res=>a.emit('reaction:toggle',{messageId:1,kind:'bogus_kind'},res));
console.log(r2?.ok===false ? 'PASS  bogus reaction still rejected' : 'FAIL  bogus accepted');
a.close(); process.exit(0);
