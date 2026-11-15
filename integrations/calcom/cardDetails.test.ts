import { expect, test } from 'bun:test';
import { detailRow, eventTypeLink, bookingsLink } from './server.ts';
test('untrusted detail text cannot inject markup',()=>{
 const html=detailRow('Summary', [['Title','<script>alert(1)</script>'],['Notes','" & < >'],['Empty','']],bookingsLink);
 expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<dt>Empty</dt>');
 expect(html).toContain('<details'); expect(html).toContain('<summary'); expect(html).toContain('https://app.cal.com/bookings');
});
test('event links accept numeric IDs and safely fall back for invalid IDs',()=>{
 expect(eventTypeLink('42').url).toBe('https://app.cal.com/event-types/42');
 for(const id of ['javascript:alert(1)','../../evil','42?x=1','https://evil.com',0,-1,undefined]) expect(eventTypeLink(id).url).toBe('https://app.cal.com/event-types');
});
test('long detail content remains intact and links are native anchors',()=>{
 const text='Long title '.repeat(100); const html=detailRow('Summary',[['Title',text]],eventTypeLink(42));
 expect(html).toContain(text); expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain('target="_blank"');
});

import { renderBookingsCard, renderEventTypesCard, detailTime } from './server.ts';
test('single and multiple meetings expose complete details and a bookings link',()=>{
 const b={title:'A long meeting title '.repeat(10),startTime:'2026-11-17T15:00:00Z',attendeeName:'Test',attendeeEmail:'test@example.com',status:'accepted'};
 for(const rows of [[b],[b,b]]) {
  const {html}=renderBookingsCard(rows,'upcoming');
  expect(html).toContain('<details'); expect(html).toContain(b.title); expect(html).toContain('https://app.cal.com/bookings'); expect(html).toContain('test@example.com');
 }
 expect(detailTime('2026-11-17T15:00:00Z')).toContain('2026');
});
test('event type cards keep full descriptions and valid links; empty cards stay empty',()=>{
 const {html}=renderEventTypesCard([{id:42,title:'Full title',slug:'demo',length:30,description:'Full description',hidden:false}]);
 expect(html).toContain('<details'); expect(html).toContain('Full description'); expect(html).toContain('https://app.cal.com/event-types/42');
 expect(renderEventTypesCard([]).html).toContain('No booking links yet');
 expect(renderBookingsCard([],'upcoming').html).toContain('No upcoming bookings');
});
