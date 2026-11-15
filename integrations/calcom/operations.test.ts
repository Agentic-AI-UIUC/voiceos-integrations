import {test, expect, beforeAll, beforeEach, afterAll} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {server, toIsoOrThrow, detailTime} from './server.ts';

// Exercise the real MCP handlers. Only the external HTTP boundary is simulated.
const originalFetch=globalThis.fetch;
const envKeys=['COMPOSIO_API_KEY','CALCOM_CONNECTED_ACCOUNT_ID','COMPOSIO_USER_ID'];
const originalEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
const client=new Client({name:'calcom-tests',version:'1'});
let calls:any[]=[], mode='', booking:any;
const eventTypes=[{id:42,title:'QA',slug:'qa',length:15},{id:43,title:'Long',slug:'long',length:40}];
const initialBooking=()=>({uid:'qa-uid',title:'QA meeting',start:'2027-03-15T14:00:00Z',status:'accepted',attendees:[{name:'QA'}]});
beforeAll(async()=>{
 process.env.COMPOSIO_API_KEY='test-key';process.env.CALCOM_CONNECTED_ACCOUNT_ID='test-account';process.env.COMPOSIO_USER_ID='test-user';
 globalThis.fetch=(async(url:any,init:any)=>{
  const body=init.body?JSON.parse(init.body):{};const slug=String(url).split('/').pop();calls.push({slug,body});
  if(mode==='write-network' && slug==='CAL_POST_NEW_BOOKING_REQUEST')throw new TypeError('Connection lost after dispatch');
  if(mode==='write-timeout' && slug==='CAL_POST_NEW_BOOKING_REQUEST')throw new DOMException('Timed out','TimeoutError');
  if(mode==='write-500' && slug==='CAL_POST_NEW_BOOKING_REQUEST')return Response.json({message:'provider failure'},{status:500});
  if(mode==='network')throw new TypeError('Connection lost');
  if(mode==='timeout')throw new DOMException('Timed out','TimeoutError');
  if(['401','429','500'].includes(mode))return Response.json({message:'provider failure'},{status:+mode});
  if(mode==='revoked')return Response.json({successful:false,error:'token expired'});
  if(mode==='conflict' && slug==='CAL_POST_NEW_BOOKING_REQUEST')return Response.json({successful:false,error:'no_available_users_found_error'});
  if(mode==='malformed')return Response.json({successful:true,data:{unexpected:true}});
  let data:any;
  if(slug==='CAL_LIST_EVENT_TYPES')data={eventTypes};
  else if(slug==='CAL_FETCH_ALL_BOOKINGS')data={bookings:mode==='empty'?[]:[booking]};
  else if(slug==='CAL_GET_AVAILABLE_SLOTS_INFO' && mode==='fall')data={slots:{'2027-11-07':[{start:'2027-11-07T04:59:00Z'},{start:'2027-11-07T05:00:00Z'},{start:'2027-11-07T06:30:00Z'},{start:'2027-11-07T07:30:00Z'},{start:'2027-11-08T05:59:00Z'},{start:'2027-11-08T06:00:00Z'}]}};
  else if(slug==='CAL_GET_AVAILABLE_SLOTS_INFO')data={slots:{'2027-03-14':[{start:'2027-03-14T05:59:00Z'},{start:'2027-03-14T06:00:00Z'},{start:'2027-03-14T07:30:00Z'},{start:'2027-03-14T08:30:00Z'},{start:'2027-03-15T04:59:00Z'},{start:'2027-03-15T05:00:00Z'}]}};
  else if(slug==='proxy')data=body.method==='GET'?booking:{id:44,...body.body};
  else if(slug==='CAL_POST_NEW_BOOKING_REQUEST')data={...booking,start:body.arguments.start};
  else if(slug==='CAL_RESCHEDULE_BOOKING_BY_UID')data={...booking,uid:'new-uid',start:body.arguments.start};
  else if(slug==='CAL_CANCEL_BOOKING_VIA_UID')data={...booking,status:'cancelled'};
  else throw new Error(`Unexpected mock endpoint ${slug}`);
  return Response.json({successful:true,data});
 }) as typeof fetch;
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
});
beforeEach(()=>{calls=[];mode='';booking=initialBooking();});
afterAll(async()=>{await client.close();await server.close();globalThis.fetch=originalFetch;for(const k of envKeys){if(originalEnv[k]===undefined)delete process.env[k];else process.env[k]=originalEnv[k];}});
async function call(name:string,args:any={}){const r:any=await client.callTool({name,arguments:args});return {...r,data:JSON.parse(r.content[0].text)};}
const create=(extra:any={})=>({title:'QA',start:'2027-03-15T09:00:00-05:00',name:'QA',email:'qa@example.com',eventTypeId:'42',duration:15,...extra});
const edit=(extra:any={})=>({bookingId:'qa-uid',title:'QA meeting',startTime:'2027-03-15T09:00:00-05:00',currentStartTime:'2027-03-15T09:00:00-05:00',attendeeName:'QA',newStartTime:'2027-03-15T10:00:00-05:00',...extra});
const writes=()=>calls.filter(c=>['CAL_CANCEL_BOOKING_VIA_UID','CAL_RESCHEDULE_BOOKING_BY_UID','CAL_POST_NEW_BOOKING_REQUEST'].includes(c.slug));

test('all seven tools exposed over MCP',async()=>expect((await client.listTools()).tools).toHaveLength(7));
for(const value of ['2027-03-14T02:30:00','2027-11-07T01:30:00','2027-03-14','March 14 2027','2027-02-29T09:00:00Z','2027-04-31T09:00:00Z','2027-01-01T24:00:00Z','2027-01-01T12:60:00Z','2027-01-01T12:00:60Z','2027-01-01T12:00:00+24:00'])test(`reject invalid or offset-free start ${value}`,()=>expect(()=>toIsoOrThrow(value,'start')).toThrow());
for(const [input,output] of [
 ['2027-03-14T01:30:00-06:00','2027-03-14T07:30:00.000Z'],
 ['2027-03-14T03:30:00-05:00','2027-03-14T08:30:00.000Z'],
 ['2027-11-07T01:30:00-05:00','2027-11-07T06:30:00.000Z'],
 ['2027-11-07T01:30:00-06:00','2027-11-07T07:30:00.000Z'],
 ['2028-02-29T12:00:00Z','2028-02-29T12:00:00.000Z'],
 ['2027-03-15T00:15:00+05:45','2027-03-14T18:30:00.000Z'],
 ['2027-03-15T00:15:00+14:00','2027-03-14T10:15:00.000Z'],
])test(`preserve explicit instant ${input}`,()=>expect(toIsoOrThrow(input,'start')).toBe(output));
test('DST duplicate hour cards distinguish CDT from CST',()=>{expect(detailTime('2027-11-07T06:30:00Z')).toContain('CDT');expect(detailTime('2027-11-07T07:30:00Z')).toContain('CST');});
test('spring gap renders 1:30 CST then 3:30 CDT',()=>{expect(detailTime('2027-03-14T07:30:00Z')).toContain('1:30 AM CST');expect(detailTime('2027-03-14T08:30:00Z')).toContain('3:30 AM CDT');});
for(const status of ['upcoming','past','cancelled'])test(`booking filter ${status}`,async()=>{const r=await call('get_bookings',{status,limit:1,attendeeEmail:'qa@example.com'});expect(r.isError).not.toBe(true);expect(calls[0].body.arguments).toMatchObject({status:[status],take:1,attendeeEmail:'qa@example.com',sortStart:status==='past'?'desc':'asc'});});
test('empty booking list is successful',async()=>{mode='empty';expect((await call('get_bookings')).data.count).toBe(0);});
test('malformed bookings fail instead of claiming empty',async()=>{mode='malformed';expect((await call('get_bookings')).isError).toBe(true);});
for(const eventTypeId of ['42','qa','QA'])test(`matching duration via ${eventTypeId}`,async()=>{expect((await call('create_booking',create({eventTypeId}))).isError).not.toBe(true);expect(writes()[0].body.arguments.start).toBe('2027-03-15T14:00:00.000Z');});
for(const eventTypeId of ['42','qa'])test(`mismatched duration blocks write via ${eventTypeId}`,async()=>{const r=await call('create_booking',create({eventTypeId,duration:40}));expect(r.isError).toBe(true);expect(writes()).toHaveLength(0);});
test('unknown numeric event type never invents duration',async()=>{expect((await call('create_booking',create({eventTypeId:'999'}))).isError).toBe(true);expect(writes()).toHaveLength(0);});
test('unknown slug blocks creation',async()=>{expect((await call('create_booking',create({eventTypeId:'missing'}))).isError).toBe(true);expect(writes()).toHaveLength(0);});
test('unsupported duration without link blocks creation',async()=>{expect((await call('create_booking',create({eventTypeId:undefined,duration:25}))).isError).toBe(true);expect(writes()).toHaveLength(0);});
for(const [dateFrom,dateTo] of [['2027-02-29','2027-03-01'],['2027-04-31','2027-05-01'],['2027-03-15','2027-03-14']])test(`invalid date range ${dateFrom} ${dateTo}`,async()=>{expect((await call('get_availability',{dateFrom,dateTo})).isError).toBe(true);expect(calls).toHaveLength(0);});
test('availability preserves local-day boundaries through 23-hour DST day',async()=>{const r=await call('get_availability',{eventTypeId:'42',dateFrom:'2027-03-14',dateTo:'2027-03-14'});expect(r.data.count).toBe(4);expect(r.data.slots.map((s:any)=>s.time)).toEqual(['2027-03-14T06:00:00Z','2027-03-14T07:30:00Z','2027-03-14T08:30:00Z','2027-03-15T04:59:00Z']);});
for(const op of ['cancel_booking','reschedule_booking']){
 test(`${op} verifies exact booking before mutation`,async()=>{const r=await call(op,edit());expect(r.isError).not.toBe(true);expect(calls[0].body.method).toBe('GET');expect(writes()).toHaveLength(1);if(op==='reschedule_booking')expect(r.data.bookingId).toBe('new-uid');});
 for(const patch of [{title:'wrong'},{attendeeName:'wrong'},{startTime:'2027-03-15T08:00:00-05:00',currentStartTime:'2027-03-15T08:00:00-05:00'}])test(`${op} rejects mismatch ${JSON.stringify(patch)}`,async()=>{expect((await call(op,edit(patch))).isError).toBe(true);expect(writes()).toHaveLength(0);});
 for(const patch of [{status:'cancelled'},{rescheduledToUid:'new-uid'},{uid:'other'}])test(`${op} refuses stale or wrong booking ${JSON.stringify(patch)}`,async()=>{Object.assign(booking,patch);expect((await call(op,edit())).isError).toBe(true);expect(writes()).toHaveLength(0);});
}
for(const error of ['401','429','500','timeout','network','revoked'])test(`provider ${error} produces error result`,async()=>{mode=error;expect((await call('get_bookings')).isError).toBe(true);});
test('booking conflict never reports success',async()=>{mode='conflict';const r=await call('create_booking',create());expect(r.isError).toBe(true);expect(r.data.error).toContain("isn't available");});
test('create event type sends correct minutes through proxy',async()=>{const r=await call('create_event_type',{title:'QA',slug:'qa-new',length:15});expect(r.isError).not.toBe(true);expect(calls[0].body.body.lengthInMinutes).toBe(15);});

for(const failure of ['write-network','write-timeout','write-500'])test(`${failure} reports uncertain outcome without retrying`,async()=>{mode=failure;const r=await call('create_booking',create());expect(r.isError).toBe(true);expect(r.data.error).toContain('may');expect(writes()).toHaveLength(1);});

for(const [name,args] of [
 ['get_bookings',{limit:0}],['get_bookings',{limit:11}],['get_bookings',{limit:1.5}],
 ['get_bookings',{status:'unknown'}],['get_bookings',{attendeeEmail:'bad-email'}],
 ['create_booking',create({email:'bad-email'})],['create_booking',create({duration:0})],
 ['create_booking',create({duration:15.5})],['create_booking',create({duration:481})],
 ['create_event_type',{title:'QA',slug:'qa',length:4}],['create_event_type',{title:'QA',slug:'qa',length:481}],
 ['cancel_booking',{bookingId:'qa-uid'}],['reschedule_booking',{bookingId:'qa-uid',newStartTime:'2027-03-15T10:00:00Z'}],
] as [string,any][])test(`MCP schema rejects ${name} ${JSON.stringify(args)}`,async()=>{const r=await client.callTool({name,arguments:args});expect(r.isError).toBe(true);expect(calls).toHaveLength(0);});

test('availability retains both repeated hours within a 25-hour fall DST day',async()=>{mode='fall';const r=await call('get_availability',{eventTypeId:'42',dateFrom:'2027-11-07',dateTo:'2027-11-07'});expect(r.data.count).toBe(4);expect(r.data.slots.map((s:any)=>s.time)).toEqual(['2027-11-07T05:00:00Z','2027-11-07T06:30:00Z','2027-11-07T07:30:00Z','2027-11-08T05:59:00Z']);});
