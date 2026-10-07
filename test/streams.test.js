import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTube, commentKind, Streams } from '../server/streams.js';
import { Hub } from '../server/hub.js';
import { normalizeSettings, maskSettings, mergeIncoming } from '../server/orgs.js';

test('YouTube: video links and channel forms', () => {
  assert.deepEqual(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTube('https://youtu.be/dQw4w9WgXcQ'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTube('https://www.youtube.com/live/dQw4w9WgXcQ?si=x'), { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTube('https://www.youtube.com/channel/UC1234567890123456789012'), { channelPath: 'channel/UC1234567890123456789012' });
  assert.deepEqual(parseYouTube('@GraceChurch'), { channelPath: '@GraceChurch' });
  assert.deepEqual(parseYouTube('https://www.youtube.com/@grace.church/streams'), { channelPath: '@grace.church' });
  assert.deepEqual(parseYouTube('gracechurch'), { channelPath: '@gracechurch' });
});

test('comments: questions and prayer requests are recognised', () => {
  assert.equal(commentKind('Can you share the verse again?'), 'question');
  assert.equal(commentKind('what time is the evening service'), 'question');
  assert.equal(commentKind('Please pray for my mom'), 'prayer');
  assert.equal(commentKind('Praying for everyone'), 'prayer');
  assert.equal(commentKind('Amen 🙌'), null);
});

test('stream keys never reach the browser and survive a save from it', () => {
  const saved = normalizeSettings({ streams: [{ name: 'YT', platform: 'youtube', channel: '@grace', apiKey: 'AIzaSECRET' }, { name: 'FB', platform: 'facebook', pageId: '123', token: 'EAAsecret' }] });
  const masked = maskSettings(saved);
  assert.equal(masked.streams[0].apiKey, '••••••••');
  assert.equal(masked.streams[1].token, '••••••••');
  const back = mergeIncoming(saved, { streams: masked.streams });
  assert.equal(back.streams[0].apiKey, 'AIzaSECRET');
  assert.equal(back.streams[1].token, 'EAAsecret');
  assert.throws(() => normalizeSettings({ streams: [{ name: 'YT', platform: 'youtube', channel: '@x' }] }), /API key/);
});

test('simulated streams: viewers, comments, pin and hide', async () => {
  const hub = new Hub();
  const s = new Streams([{ id: 'yt', name: 'YouTube', platform: 'simulator', simPlatform: 'youtube' }], hub);
  const events = [];
  s.on('change', (m) => events.push(m));
  s.start();
  try {
  assert.equal(hub.state.streams.yt.live, true);
  assert.ok(hub.state.streams.yt.viewers > 0);
  assert.equal(hub.state.streams.yt.platform, 'youtube');
  s.addComments({ id: 'yt', name: 'YouTube', platform: 'simulator' }, [{ pid: '1', author: 'Ann', text: 'Where are the notes?' }, { pid: '1', author: 'Ann', text: 'dup' }]);
  assert.equal(s.comments.filter((c) => c.id === 'yt:1').length, 1, 'no duplicates');
  assert.equal(s.comments.find((c) => c.id === 'yt:1').kind, 'question');
  s.pin('yt:1');
  assert.equal(s.snapshot().pinned.author, 'Ann');
  s.hide('yt:1');
  assert.equal(s.snapshot().pinned, null);
  assert.ok(events.some((e) => e.type === 'comments') && events.some((e) => e.type === 'hide'));
  } finally {
    s.stop();
    hub.stop();
  }
});
