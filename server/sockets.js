// ============================================================================
// Ikvizz — Live layer (Socket.IO): presence, intent signals, messages, reads,
// context changes. The Intent Engine lives here: clients stream lightweight
// editing telemetry; we broadcast a human word — thinking / writing / reflecting.
// ============================================================================
import { Server } from 'socket.io';
import { db, userCanAccessConversation, conversationMemberIds } from './db.js';
import { verifySocketToken } from './auth.js';
import { sendMessage, markRead, visibleContext, toggleReaction, editMessage, deleteMessage, replyPreviewFor, maskCapsule, maskViewOnce, openViewOnce, votePoll } from './core.js';
import { inferIntent, CONTEXTS } from './brain.js';
import { wireNotify, notify } from './notify.js';

/** userId -> Set<socketId> */
const online = new Map();

/** Group calls (Phase 7): space conversationId -> Map<userId, {media}> */
const roomCalls = new Map();

export function createSocketLayer(httpServer) {
  const io = new Server(httpServer, { cors: { origin: false } });
  wireNotify(io, userId => online.has(userId));

  io.use((socket, next) => {
    const uid = verifySocketToken(socket.handshake.auth?.token);
    if (!uid) return next(new Error('unauthorized'));
    socket.userId = uid;
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.userId;
    if (!online.has(uid)) online.set(uid, new Set());
    online.get(uid).add(socket.id);
    socket.join(`user:${uid}`);
    broadcastPresence(io, uid, true);

    // Per-socket flood guard for message sends (token-bucket, ~5/sec burst 15)
    let sendTokens = 15; let lastRefill = Date.now();
    const canSend = () => {
      const now = Date.now();
      sendTokens = Math.min(15, sendTokens + (now - lastRefill) / 1000 * 5);
      lastRefill = now;
      if (sendTokens < 1) return false;
      sendTokens -= 1; return true;
    };

    // ---- join/leave conversation rooms (access-checked) --------------------
    socket.on('conversation:join', (conversationId) => {
      const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(Number(conversationId));
      if (convo && userCanAccessConversation(uid, convo)) socket.join(`convo:${convo.id}`);
    });
    socket.on('conversation:leave', (conversationId) => socket.leave(`convo:${Number(conversationId)}`));

    // ---- send a message -----------------------------------------------------
    socket.on('message:send', (payload, ack) => {
      try {
        if (!canSend()) throw new Error('Slow down a sec — too many messages at once.');
        const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(Number(payload?.conversationId));
        if (!convo || !userCanAccessConversation(uid, convo)) throw new Error('Conversation not found.');
        let msg = sendMessage({
          conversationId: convo.id, senderId: uid, body: payload.body,
          replyTo: payload.replyTo || null, kind: payload.kind || 'text',
          attachment: payload.attachment || null, effect: payload.effect || null,
          silent: !!payload.silent, unlockAt: payload.unlockAt || null, mood: payload.mood || null,
          forwarded: !!payload.forwarded, pollOptions: payload.pollOptions || null, location: payload.location || null,
          viewOnce: !!payload.viewOnce,
        });
        msg = maskViewOnce(maskCapsule(msg)); // capsules + view-once go out dark, even to their author
        msg.reactions = [];
        msg.reply = msg.reply_to ? (replyPreviewFor([msg.id])[msg.id] || null) : null;
        io.to(`convo:${convo.id}`).emit('message:new', { conversationId: convo.id, message: msg });
        // Nudge members who aren't in the room (for list badges / briefing)
        const mentioned = msg.signals.find(s => s.type === 'mention')?.users || [];
        for (const memberId of conversationMemberIds(convo)) {
          if (memberId !== uid) io.to(`user:${memberId}`).emit('inbox:update', {
            conversationId: convo.id, priority: msg.priority,
            mentioned: mentioned.includes(memberId),
            from: msg.sender.display_name, preview: msg.kind === 'sealed' ? 'Encrypted message' : (msg.body || '').slice(0, 80),
          });
        }
        ack?.({ ok: true, message: msg });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    // ---- reactions / edit / delete ------------------------------------------
    socket.on('reaction:toggle', ({ messageId, kind } = {}, ack) => {
      try {
        const m = db.prepare(`SELECT conversation_id FROM messages WHERE id=?`).get(Number(messageId));
        const convo = m && db.prepare(`SELECT * FROM conversations WHERE id=?`).get(m.conversation_id);
        if (!convo || !userCanAccessConversation(uid, convo)) throw new Error('Not found.');
        const r = toggleReaction(Number(messageId), uid, String(kind));
        io.to(`convo:${r.conversationId}`).emit('reaction:update', { conversationId: r.conversationId, messageId: Number(messageId), reactions: r.reactions });
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    socket.on('message:edit', ({ messageId, body } = {}, ack) => {
      try {
        const msg = editMessage(Number(messageId), uid, body);
        io.to(`convo:${msg.conversation_id}`).emit('message:edited', { conversationId: msg.conversation_id, message: msg });
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    socket.on('message:delete', ({ messageId } = {}, ack) => {
      try {
        const r = deleteMessage(Number(messageId), uid);
        io.to(`convo:${r.conversationId}`).emit('message:deleted', { conversationId: r.conversationId, messageId: Number(messageId) });
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    // ---- view-once photo (open exactly once, then it's gone) ----------------
    socket.on('message:viewonce:open', ({ messageId } = {}, ack) => {
      try {
        const m = db.prepare(`SELECT conversation_id FROM messages WHERE id=?`).get(Number(messageId));
        const convo = m && db.prepare(`SELECT * FROM conversations WHERE id=?`).get(m.conversation_id);
        if (!convo || !userCanAccessConversation(uid, convo)) throw new Error('Not found.');
        const r = openViewOnce(Number(messageId), uid); // records the view + wipes the attachment
        // Tell the room it's now spent so both bubbles flip to "Opened" (and stay
        // that way on reload, since the row no longer holds the image).
        io.to(`convo:${r.conversationId}`).emit('viewonce:opened', { conversationId: r.conversationId, messageId: Number(messageId) });
        ack?.({ ok: true, url: r.url, name: r.name, type: r.type });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    // ---- live location updates (patch the pin on the same message) ----------
    socket.on('location:update', ({ messageId, lat, lng, stop } = {}) => {
      const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(messageId));
      if (!m || m.sender_id !== uid) return; // only the sharer may move their own pin
      const signals = JSON.parse(m.signals || '[]');
      const locSig = signals.find(s => s.type === 'location');
      if (!locSig) return;
      if (stop) { locSig.live = false; }
      else {
        const la = Number(lat), ln = Number(lng);
        if (!(Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180)) return;
        locSig.lat = +la.toFixed(6); locSig.lng = +ln.toFixed(6);
      }
      db.prepare(`UPDATE messages SET signals=? WHERE id=?`).run(JSON.stringify(signals), m.id);
      const sender = db.prepare(`SELECT id, username, display_name, avatar_hue, avatar_url FROM users WHERE id=?`).get(uid);
      const msg = { ...m, signals, attachment: m.attachment ? JSON.parse(m.attachment) : null, sender };
      io.to(`convo:${m.conversation_id}`).emit('message:edited', { conversationId: m.conversation_id, message: msg });
    });

    // ---- polls ---------------------------------------------------------------
    socket.on('poll:vote', ({ messageId, opt } = {}, ack) => {
      try {
        const m = db.prepare(`SELECT conversation_id FROM messages WHERE id=?`).get(Number(messageId));
        const convo = m && db.prepare(`SELECT * FROM conversations WHERE id=?`).get(m.conversation_id);
        if (!convo || !userCanAccessConversation(uid, convo)) throw new Error('Not found.');
        const r = votePoll(Number(messageId), uid, opt);
        io.to(`convo:${r.conversationId}`).emit('poll:update', { conversationId: r.conversationId, messageId: Number(messageId), votes: { counts: r.votes.counts, total: r.votes.total } });
        ack?.({ ok: true, votes: r.votes });
      } catch (e) { ack?.({ ok: false, error: e.message }); }
    });

    // ---- WebRTC call signaling (1:1) ------------------------------------------
    // Pure relay: offers/answers/ICE/hangup travel between two people who share
    // a relationship. Media flows peer-to-peer — the server never sees it.
    socket.on('call:signal', ({ to, data } = {}) => {
      const otherId = Number(to);
      if (!otherId || typeof data !== 'object') return;
      const related = db.prepare(`SELECT 1 FROM relationships WHERE user_id=? AND other_id=?`).get(uid, otherId)
        || db.prepare(`SELECT 1 FROM relationships WHERE user_id=? AND other_id=?`).get(otherId, uid);
      if (!related) return;
      const me = db.prepare(`SELECT display_name, avatar_hue, avatar_url FROM users WHERE id=?`).get(uid);
      // Offer to someone who isn't here → a missed call they'll actually see
      if (data.type === 'offer' && !online.has(otherId)) {
        notify(otherId, 'call', `Missed ${data.media === 'video' ? 'video' : 'voice'} call from ${me.display_name}`, '', { from: uid });
      }
      io.to(`user:${otherId}`).emit('call:signal', { from: uid, fromName: me.display_name, fromHue: me.avatar_hue, fromAvatar: me.avatar_url, data });
    });

    // ---- Music Sync: co-listen to a user-uploaded clip in real time ----------
    // Pure relay of an uploaded /files audio clip + play/pause/seek state. We
    // host nothing new — it's the clip they already uploaded. 100% free.
    socket.on('music:sync', ({ conversationId, action, url, at, t } = {}) => {
      const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(Number(conversationId));
      if (!convo || !userCanAccessConversation(uid, convo)) return;
      if (!['start', 'play', 'pause', 'stop'].includes(action)) return;
      if (action === 'start' && !(typeof url === 'string' && url.startsWith('/files/') && !url.includes('..'))) return;
      const me = db.prepare(`SELECT display_name FROM users WHERE id=?`).get(uid);
      // Broadcast to everyone else in the conversation room
      socket.to(`convo:${convo.id}`).emit('music:sync', {
        conversationId: convo.id, from: uid, fromName: me.display_name,
        action, url, at: Number(at) || Date.now(), t: Number(t) || 0,
      });
    });

    // ---- Group calls in Living Spaces (Phase 7) -------------------------------
    // Mesh WebRTC: the server only relays handshakes and tracks who's in the
    // room. The NEWCOMER initiates an offer to each existing peer — no glare.
    const userMeta = id => {
      const u = db.prepare(`SELECT id, display_name, avatar_hue, avatar_url FROM users WHERE id=?`).get(id);
      return u && { userId: u.id, name: u.display_name, hue: u.avatar_hue, avatar: u.avatar_url };
    };
    const roomState = convoId => {
      const room = roomCalls.get(convoId);
      io.to(`convo:${convoId}`).emit('call:room:state', { conversationId: convoId, count: room?.size || 0 });
    };
    const leaveRoomCall = (convoId) => {
      const room = roomCalls.get(convoId);
      if (!room?.has(uid)) return;
      room.delete(uid);
      if (!room.size) roomCalls.delete(convoId);
      socket.leave(`gcall:${convoId}`);
      io.to(`gcall:${convoId}`).emit('call:room:peer-left', { conversationId: convoId, userId: uid });
      roomState(convoId);
    };

    // Free mesh scales as N² in bandwidth — an honest, enforced cap keeps calls
    // watchable. 5 is the sweet spot for a vibe room on home networks.
    const ROOM_MAX = 5;

    socket.on('call:room:join', ({ conversationId, media, party } = {}, ack) => {
      const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(Number(conversationId));
      if (!convo || convo.kind !== 'space' || !userCanAccessConversation(uid, convo)) return ack?.({ ok: false, error: 'Not your space.' });
      let room = roomCalls.get(convo.id);
      if (!room) { room = new Map(); room.party = !!party; roomCalls.set(convo.id, room); } // first joiner sets the vibe
      if (!room.has(uid) && room.size >= ROOM_MAX) {
        return ack?.({ ok: false, error: `Room's full — ${ROOM_MAX} is the free-mesh limit. Start another room or wait for a spot.` });
      }
      const peers = [...room.keys()].filter(id => id !== uid).map(userMeta).filter(Boolean);
      room.set(uid, { media: media === 'video' ? 'video' : 'audio' });
      socket.join(`gcall:${convo.id}`);
      socket.to(`gcall:${convo.id}`).emit('call:room:peer-joined', { conversationId: convo.id, ...userMeta(uid) });
      roomState(convo.id);
      ack?.({ ok: true, peers, party: !!room.party, max: ROOM_MAX });
    });

    socket.on('call:room:signal', ({ conversationId, to, data } = {}) => {
      const convoId = Number(conversationId), otherId = Number(to);
      const room = roomCalls.get(convoId);
      if (!room?.has(uid) || !room?.has(otherId) || typeof data !== 'object') return;
      io.to(`user:${otherId}`).emit('call:room:signal', { conversationId: convoId, from: uid, ...userMeta(uid), data });
    });

    // Party Vibez: floating mood reactions during a call (relayed, ephemeral)
    socket.on('call:room:react', ({ conversationId, kind } = {}) => {
      const room = roomCalls.get(Number(conversationId));
      if (!room?.has(uid) || typeof kind !== 'string') return;
      io.to(`gcall:${Number(conversationId)}`).emit('call:room:react', { conversationId: Number(conversationId), from: uid, kind: kind.slice(0, 16) });
    });

    socket.on('call:room:leave', ({ conversationId } = {}) => leaveRoomCall(Number(conversationId)));

    // ---- Intent Engine ------------------------------------------------------
    // payload: { conversationId, draftLength, msSinceKeystroke, deletedRecently, explicit }
    socket.on('intent', (payload) => {
      const convoId = Number(payload?.conversationId);
      const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(convoId);
      if (!convo || !userCanAccessConversation(uid, convo)) return;
      const intent = payload?.explicit || (payload?.stopped ? null : inferIntent(payload || {}));
      socket.to(`convo:${convoId}`).emit('intent', { conversationId: convoId, userId: uid, intent });
    });

    // ---- read receipts ------------------------------------------------------
    socket.on('conversation:read', (conversationId) => {
      const convo = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(Number(conversationId));
      if (!convo || !userCanAccessConversation(uid, convo)) return;
      const lastReadId = markRead(convo.id, uid);
      socket.to(`convo:${convo.id}`).emit('read', { conversationId: convo.id, userId: uid, lastReadId });
    });

    // ---- Context Engine: live context changes ------------------------------
    socket.on('context:set', ({ context, note, scope } = {}) => {
      if (context && !CONTEXTS.some(c => c.key === context)) return;
      const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(uid);
      db.prepare(`UPDATE users SET context=?, context_note=?, context_scope=? WHERE id=?`)
        .run(context || u.context, note ?? u.context_note, ['all','inner','none'].includes(scope) ? scope : u.context_scope, uid);
      broadcastContext(io, uid);
    });

    socket.on('disconnect', () => {
      const set = online.get(uid);
      set?.delete(socket.id);
      if (!set || set.size === 0) {
        online.delete(uid);
        broadcastPresence(io, uid, false);
        for (const convoId of [...roomCalls.keys()]) leaveRoomCall(convoId); // hang up cleanly
      }
    });
  });

  return io;
}

export const isOnline = (userId) => online.has(userId);
export const onlineIds = () => [...online.keys()];

/** Tell everyone who has a relationship with `uid` about presence changes. */
function broadcastPresence(io, uid, isOn) {
  const related = db.prepare(`SELECT user_id FROM relationships WHERE other_id=?`).all(uid);
  for (const r of related) io.to(`user:${r.user_id}`).emit('presence', { userId: uid, online: isOn });
}

/** Context changes respect per-viewer visibility (all / inner circle / none). */
function broadcastContext(io, uid) {
  const target = db.prepare(`SELECT * FROM users WHERE id=?`).get(uid);
  const related = db.prepare(`SELECT user_id FROM relationships WHERE other_id=?`).all(uid);
  for (const r of related) {
    const ctx = visibleContext(target, r.user_id);
    io.to(`user:${r.user_id}`).emit('context', { userId: uid, ...ctx });
  }
}
