import { io } from 'socket.io-client';
const BASE='http://localhost:4321';
const login=async u=>(await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'aether123'})})).json()).token;
const a=io(BASE,{auth:{token:await login('aarav')}}); await new Promise(x=>a.on('connect',x));
a.emit('conversation:join',1); await new Promise(x=>setTimeout(x,150));
for (const k of ['tea','braincell','groan','chrome','vibepass','overthink']) {
  const r=await new Promise(res=>a.emit('reaction:toggle',{messageId:1,kind:k},res));
  console.log((r?.ok?'PASS':'FAIL')+'  ceramic vibe: '+k);
}
a.close(); process.exit(0);
