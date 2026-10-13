// Seeds an empty dev database (API on :3000 with AUTH_MODE=dev) with the demo accounts and Jul–Oct 2026 hours. Then run record.mjs.
const API='http://localhost:3000/api', T='mom@demo.test', S='supervisor@demo.test';
const call=async(sub,p,m='GET',b)=>{const r=await fetch(API+p,{method:m,headers:{'x-dev-sub':sub,...(b?{'content-type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});const t=await r.text();if(!r.ok)throw new Error(`${m} ${p} ${r.status} ${t}`);return t?JSON.parse(t):null};
const s=await call(S,'/signup','POST',{role:'supervisor',fullName:'Dana Reyes, BCBA',bacbId:'1-23-45678'});
await call(T,'/signup','POST',{role:'trainee',fullName:'Mom Marshall',fieldworkType:'supervised'});
const link=await call(T,'/supervisions','POST',{inviteCode:s.inviteCode,startsOn:'2026-07-01'});
const me=await call(S,'/me'); const sid=me.id??me.user?.id; console.log('sup',JSON.stringify(me).slice(0,200));
const d=(y,m,day)=>`${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
let n=0;
for(const [m,last] of [[7,31],[8,31],[9,30],[10,12]]) for(let day=1;day<=last;day++){
  const wd=new Date(Date.UTC(2026,m-1,day)).getUTCDay(); if(wd===0||wd===6) continue;
  const put=(b)=>call(T,`/entries/${crypto.randomUUID()}`,'PUT',{supervisorId:sid,workDate:d(2026,m,day),...b});
  await put({startTime:'09:00',endTime:'13:00',kind:'independent',restrictedMinutes:wd%2?120:180,description:''}); n++;
  if(wd===3) { await put({startTime:'13:30',endTime:'15:00',kind:'supervised',contact:day<8?'observation':'contact',format:'in_person',restrictedMinutes:30}); n++; }
  if(wd===5&&day>14) { await put({startTime:'14:00',endTime:'15:00',kind:'supervised',isGroup:true,contact:'contact',format:'online',restrictedMinutes:0}); n++; }
}
console.log('entries',n);

await call(T,'/external-signatures','PUT',{supervisorId:sid,month:'2026-07',signedOn:'2026-08-05'});
await call(T,'/external-signatures','PUT',{supervisorId:sid,month:'2026-08',signedOn:'2026-09-04'});
const t=me;
await call(T,'/verifications/2026-09/sign','POST',{supervisorId:sid,signature:'Mom Marshall',attest:true});
console.log('signed sep trainee; trainee id',t.id);
