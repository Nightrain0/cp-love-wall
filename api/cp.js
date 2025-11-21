import admin from 'firebase-admin';

// --- 初始化逻辑 ---
if (!admin.apps.length) {
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        } catch (e) { console.error("Firebase Init Error:", e); }
    } else { console.error("Missing FIREBASE_CREDENTIALS"); }
}

const getDb = () => { try { return admin.firestore(); } catch (e) { return null; } };
const hashPassword = (pwd) => Buffer.from(pwd + "cpdd_salt").toString('base64');
const getIdentifier = (req, body) => body?.username ? 'user:'+body.username : 'ip:'+(req.headers['x-forwarded-for']||'unknown').split(',')[0];
const getChatId = (u1, u2) => [u1, u2].sort().join('_');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const db = getDb();
    if (!db) return res.status(500).json({ error: 'DB Error' });

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

        // --- 社交模块 ---

        if (req.method === 'GET' && action === 'get_user_profile') {
            const doc = await db.collection('cp_users').doc(req.query.username).get();
            if (!doc.exists) return res.status(404).json({ error: '无此用户' });
            const d = doc.data();
            return res.json({ username: d.username, nickname: d.nickname, avatar: d.avatar, gender: d.gender||'secret', target: d.target||'all', qq: d.qq||'', wx: d.wx||'' });
        }

        if (req.method === 'POST' && action === 'chat_send') {
            const { user, toUsername, content } = body;
            if (!user || !content) return res.status(400).json({ error: '参数错误' });
            const chatId = getChatId(user.username, toUsername);
            const chatRef = db.collection('cp_chats').doc(chatId);
            const now = admin.firestore.FieldValue.serverTimestamp();

            await db.runTransaction(async (t) => {
                const doc = await t.get(chatRef);
                let unreadMap = doc.exists ? (doc.data().unreadCounts || {}) : {};
                unreadMap[toUsername] = (unreadMap[toUsername] || 0) + 1;
                
                const chatData = { participants: [user.username, toUsername], lastMsg: content, lastSender: user.username, updatedAt: now, unreadCounts: unreadMap };
                if (!doc.exists) chatData.createdAt = now;
                
                const hidden = doc.exists ? (doc.data().hiddenFor || []) : [];
                if (hidden.length > 0) {
                    chatData.hiddenFor = hidden.filter(u => u !== user.username && u !== toUsername);
                }

                t.set(chatRef, chatData, { merge: true });
                t.set(chatRef.collection('messages').doc(), { sender: user.username, content, timestamp: now });
            });
            return res.json({ success: true });
        }

        if (req.method === 'GET' && action === 'chat_inbox') {
            const myUsername = req.query.username;
            const snap = await db.collection('cp_chats').where('participants', 'array-contains', myUsername).get();
            
            const chats = [];
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0));

            for (const d of docs) {
                if (d.hiddenFor && d.hiddenFor.includes(myUsername)) continue;

                const otherUser = d.participants.find(p => p !== myUsername);
                let otherInfo = { nickname: otherUser, avatar: '' };
                const uDoc = await db.collection('cp_users').doc(otherUser).get();
                if (uDoc.exists) otherInfo = uDoc.data();

                chats.push({
                    chatId: d.id,
                    otherUsername: otherUser,
                    otherNickname: otherInfo.nickname,
                    otherAvatar: otherInfo.avatar,
                    lastMsg: d.lastMsg,
                    updatedAt: d.updatedAt,
                    unread: (d.unreadCounts && d.unreadCounts[myUsername]) || 0
                });
            }
            return res.json(chats);
        }

        if (req.method === 'POST' && action === 'chat_read') {
            const { user, chatId } = body;
            const ref = db.collection('cp_chats').doc(chatId);
            await db.runTransaction(async t => {
                const doc = await t.get(ref);
                if (!doc.exists) return;
                const map = doc.data().unreadCounts || {};
                if (map[user.username] > 0) {
                    map[user.username] = 0;
                    t.update(ref, { unreadCounts: map });
                }
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_chat_session') {
            const { user, chatId } = body;
            const ref = db.collection('cp_chats').doc(chatId);
            await db.runTransaction(async t => {
                const doc = await t.get(ref);
                if (!doc.exists) return;
                let hidden = doc.data().hiddenFor || [];
                if (!hidden.includes(user.username)) {
                    hidden.push(user.username);
                    t.update(ref, { hiddenFor: hidden });
                }
            });
            return res.json({ success: true });
        }

        if (req.method === 'GET' && action === 'chat_history') {
            const chatId = getChatId(req.query.u1, req.query.u2);
            const snap = await db.collection('cp_chats').doc(chatId).collection('messages').orderBy('timestamp', 'asc').limit(50).get();
            const msgs = snap.docs.map(d => {
                const data = d.data();
                let ts = '';
                if(data.timestamp) { 
                    const dt = new Date(data.timestamp._seconds * 1000);
                    ts = `${dt.getHours()}:${String(dt.getMinutes()).padStart(2,'0')}`;
                }
                return { id: d.id, ...data, timeStr: ts };
            });
            return res.json(msgs);
        }

        // --- 鉴权 & 帖子 ---
        if (action === 'register') {
            // ★ 更新：注册时接收详细信息
            const { username, password, nickname, avatar, gender, target, qq, wx } = body;
            if (username !== 'admin' && (!username || username.length < 8)) return res.status(400).json({ error: '账号需≥8位' });
            if (!password || password.length < 6) return res.status(400).json({ error: '密码需≥6位' });
            if ((await db.collection('cp_users').doc(username).get()).exists) return res.status(400).json({ error: '账号已存在' });
            
            const u = { 
                username, 
                password: hashPassword(password), 
                nickname, 
                avatar: avatar||'', 
                isAdmin: username==='admin', 
                gender: gender || 'secret', // 默认值
                target: target || 'all',    // 默认值
                qq: qq || '',
                wx: wx || '',
                createdAt: new Date() 
            };
            await db.collection('cp_users').doc(username).set(u); 
            delete u.password;
            return res.json({ success: true, user: u });
        }

        if (action === 'login') {
            const doc = await db.collection('cp_users').doc(body.username).get();
            if (!doc.exists) return res.status(400).json({ error: '账号不存在' });
            const u = doc.data();
            if (u.lockUntil && u.lockUntil.toMillis() > Date.now()) return res.status(403).json({ error: '账号锁定中' });
            if (u.password !== hashPassword(body.password)) {
                let fails = (u.fails || 0) + 1;
                let updates = { fails };
                if (fails >= 3) updates.lockUntil = admin.firestore.Timestamp.fromMillis(Date.now() + 30*60*1000);
                await db.collection('cp_users').doc(body.username).update(updates);
                return res.status(400).json({ error: `密码错误` });
            }
            if(u.fails) await db.collection('cp_users').doc(body.username).update({ fails: 0, lockUntil: null });
            u.isAdmin = (u.username === 'admin'); delete u.password;
            return res.json({ success: true, user: u });
        }

        if (req.method === 'POST' && action === 'update_profile') {
            if (body.user.username !== body.username) return res.status(403).json({ error: '非法' });
            await db.collection('cp_users').doc(body.username).update({
                nickname: body.nickname, avatar: body.avatar, gender: body.gender, target: body.target, qq: body.qq, wx: body.wx
            });
            const u = (await db.collection('cp_users').doc(body.username).get()).data(); delete u.password;
            return res.json({ success: true, user: u });
        }

        if (req.method === 'GET' && !action) {
            try {
                const snap = await db.collection('cp_posts').orderBy('timestamp', 'desc').limit(60).get();
                const posts = [];
                snap.forEach(d => {
                    const data = d.data();
                    let timeStr = "刚刚";
                    if(data.timestamp) { const dt = new Date(data.timestamp._seconds * 1000); timeStr = `${dt.getMonth()+1}-${dt.getDate()} ${dt.getHours()}:${String(dt.getMinutes()).padStart(2,'0')}`; }
                    posts.push({ id: d.id, ...data, timeStr, likedIds: data.likedIds||[] });
                });
                return res.json(posts);
            } catch(e) { return res.status(500).json({ error: '加载失败' }); }
        }

        if (req.method === 'POST' && action === 'create_post') {
            // ★ 修复：使用 || 操作符提供默认值，防止 undefined 报错
            await db.collection('cp_posts').add({
                nickname: body.user.nickname || '匿名', 
                username: body.user.username, 
                avatar: body.user.avatar || '',
                gender: body.user.gender || 'secret', // 防止 undefined
                target: body.user.target || 'all',    // 防止 undefined
                qq: body.user.qq || '',
                wx: body.user.wx || '',
                game: body.game, 
                desc: body.content, 
                requirement: body.requirement || '', 
                images: body.images || [],
                likes: 0, likedIds: [], commentsCount: 0, timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_post') {
            const doc = await db.collection('cp_posts').doc(body.id).get();
            if(doc.exists && (body.user.username==='admin' || body.user.username===doc.data().username)) await doc.ref.delete();
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'like') {
            const ref = db.collection('cp_posts').doc(body.id);
            const uid = getIdentifier(req, body.user);
            await db.runTransaction(async t => {
                const doc = await t.get(ref); if(!doc.exists) return;
                const d = doc.data(); const ids = d.likedIds||[]; const idx = ids.indexOf(uid);
                if (idx > -1) { ids.splice(idx, 1); t.update(ref, { likedIds: ids, likes: Math.max(0, (d.likes||0)-1) }); }
                else { if(ids.length > 2000) ids.shift(); ids.push(uid); t.update(ref, { likedIds: ids, likes: (d.likes||0)+1 }); }
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'add_comment') {
            const ref = db.collection('cp_posts').doc(body.postId);
            await db.runTransaction(async t => {
                t.set(ref.collection('comments').doc(), {
                    nickname: body.user.nickname, username: body.user.username, avatar: body.user.avatar,
                    content: body.content, timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                t.update(ref, { commentsCount: admin.firestore.FieldValue.increment(1) });
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_comment') {
            const ref = db.collection('cp_posts').doc(body.postId);
            const cmtRef = ref.collection('comments').doc(body.commentId);
            const cmt = await cmtRef.get();
            if(cmt.exists && (body.user.username==='admin' || body.user.username===cmt.data().username)) {
                await cmtRef.delete(); await ref.update({ commentsCount: admin.firestore.FieldValue.increment(-1) });
            }
            return res.json({ success: true });
        }
        
        if (req.method === 'GET' && action === 'get_comments') {
            const snap = await db.collection('cp_posts').doc(req.query.postId).collection('comments').orderBy('timestamp', 'asc').get();
            return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }

        return res.status(404).json({ error: 'API not found' });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
}
