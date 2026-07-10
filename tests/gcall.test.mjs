import { io } from 'socket.io-client';
const BASE='http://localhost:4321';
const login=async u=>(await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'aether123'})})).json()).token;
// find a shared space conversation (Startup space has aarav+rahul+maya)
const tokA=await login('aarav'), tokR=await login('rahul');
const spaces=await (await fetch(BASE+'/api/spaces',{headers:{Authorization:'Bearer '+tokA}})).json();
// pick a space BOTH aarav and rahul belong to (seeded "Startup" has both)
let convoId=null;
for(const s of spaces.spaces){
  const det=await (await fetch(BASE+'/api/spaces/'+s.id,{headers:{Authorization:'Bearer '+tokA}})).json();
  if(det.members?.some(m=>m.username==='rahul')){ convoId=det.conversation_id; break; }
}
if(!convoId){ console.log('FAIL  no shared space for aarav+rahul (reseed needed)'); process.exit(1); }
const a=io(BASE,{auth:{token:tokA}}), r=io(BASE,{auth:{token:tokR}});
await Promise.all([new Promise(x=>a.on('connect',x)),new Promise(x=>r.on('connect',x))]);
let pass=0,tot=0; const ok=(n,c)=>{tot++;if(c)pass++;console.log((c?'PASS':'FAIL')+'  '+n)};
// aarav joins room first
const j1=await new Promise(res=>a.emit('call:room:join',{conversationId:convoId,media:'audio'},res));
ok('aarav joins room (0 peers so far)', j1?.ok && Array.isArray(j1.peers));
// rahul joins, should see aarav as a peer + aarav gets peer-joined
const joined=new Promise(res=>a.once('call:room:peer-joined',d=>res(d)));
const j2=await new Promise(res=>r.emit('call:room:join',{conversationId:convoId,media:'audio'},res));
ok('rahul joins and sees aarav as peer', j2?.ok && j2.peers.some(p=>p.name?.includes('Aarav')));
const pj=await Promise.race([joined,new Promise(res=>setTimeout(()=>res(null),1500))]);
ok('aarav notified of rahul joining', pj && pj.name?.includes('Rahul'));
// signal relay between peers
const sigSeen=new Promise(res=>r.once('call:room:signal',d=>res(d)));
a.emit('call:room:signal',{conversationId:convoId,to:j2.peers[0]?.userId||pj?.userId,data:{type:'offer',sdp:'x'}});
// aarav's target is rahul; find rahul's id from peer-joined
const rid=pj?.userId;
const sigSeen2=new Promise(res=>r.once('call:room:signal',d=>res(d)));
a.emit('call:room:signal',{conversationId:convoId,to:rid,data:{type:'offer',sdp:'x'}});
const sg=await Promise.race([sigSeen2,new Promise(res=>setTimeout(()=>res(null),1500))]);
ok('mesh signal relayed peer→peer', sg && sg.data?.type==='offer');
ok('room vibe carried in join ack', j2 && j2.party === false && j2.max === 5);
// party reaction relay
const reactSeen=new Promise(res=>a.once('call:room:react',d=>res(d)));
r.emit('call:room:react',{conversationId:convoId,kind:'hyped'});
const rc=await Promise.race([reactSeen,new Promise(res=>setTimeout(()=>res(null),1500))]);
ok('party reaction relayed to room', rc && rc.kind==='hyped');
// leave
const left=new Promise(res=>a.once('call:room:peer-left',d=>res(d)));
r.emit('call:room:leave',{conversationId:convoId});
const lv=await Promise.race([left,new Promise(res=>setTimeout(()=>res(null),1500))]);
ok('peer-left broadcast on leave', !!lv);
// cap is advertised to the client (enforcement is a room.size>=max guard;
// can't fill 5 distinct seats here since one user = one seat by design)
ok('room cap advertised to client (max=5)', j2.max === 5);
console.log(pass+'/'+tot);
a.close();r.close();process.exit(pass===tot?0:1);
