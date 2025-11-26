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

    const validateUser = async (username) => {
        if (!username) return false;
        const doc = await db.collection('cp_users').doc(username).get();
        return doc.exists;
    };

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

        // --- 管理员专属功能 ---
        
        if (req.method === 'GET' && action === 'admin_get_users') {
            if (req.query.requestor !== 'admin') return res.status(403).json({ error: '无权访问' });
            const snap = await db.collection('cp_users').orderBy('createdAt', 'desc').limit(100).get();
            const users = snap.docs.map(d => {
                const u = d.data();
                delete u.password; 
                return u;
            });
            return res.json(users);
        }

        if (req.method === 'POST' && action === 'admin_delete_user') {
            if (body.user?.username !== 'admin') return res.status(403).json({ error: '无权访问' });
            const targetUser = body.targetUsername;
            if (!targetUser || targetUser === 'admin') return res.status(400).json({ error: '操作非法' });
            
            await db.collection('cp_users').doc(targetUser).delete();
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'admin_add_user') {
            if (body.user?.username !== 'admin') return res.status(403).json({ error: '无权访问' });
            
            const newUser = body.newUser || {};
            const { username, password, nickname, gender, target } = newUser;
            
            if (!username || username.length < 4) return res.status(400).json({ error: '账号无效' });
            
            const docRef = db.collection('cp_users').doc(username);
            if ((await docRef.get()).exists) return res.status(400).json({ error: '账号已存在' });

            const u = { 
                username, 
                password: hashPassword(password || '123456'), 
                nickname: nickname || '新用户', 
                avatar: '', 
                isAdmin: false, 
                gender: gender || 'secret', 
                target: target || 'all',    
                qq: '',
                wx: '',
                createdAt: new Date() 
            };
            await docRef.set(u);
            return res.json({ success: true, user: u });
        }

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
            
            if (!(await validateUser(user.username))) {
                return res.status(401).json({ error: '账号异常' });
            }

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
                let otherInfo = { nickname: '未知用户', avatar: '' };
                try {
                    const uDoc = await db.collection('cp_users').doc(otherUser).get();
                    if (uDoc.exists) otherInfo = uDoc.data();
                } catch(e) {}

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
                gender: gender || 'secret', 
                target: target || 'all',    
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
            if (!body.user) return res.status(400).json({ error: '用户未登录' });
            
            if (!(await validateUser(body.user.username))) {
                return res.status(401).json({ error: '账号不存在' });
            }

            await db.collection('cp_posts').add({
                nickname: body.user.nickname || '匿名', 
                username: body.user.username, 
                avatar: body.user.avatar || '',
                gender: body.user.gender || 'secret', 
                target: body.user.target || 'all',    
                qq: body.user.qq || '',
                wx: body.user.wx || '',
                game: body.game || '其他', 
                desc: body.content || '', 
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

        // --- 优化：返回评论 ID ---
        if (req.method === 'POST' && action === 'add_comment') {
            if (!(await validateUser(body.user.username))) {
                return res.status(401).json({ error: '账号异常' });
            }

            const ref = db.collection('cp_posts').doc(body.postId);
            // 1. 先生成 ID
            const newCommentRef = ref.collection('comments').doc();
            const newCommentId = newCommentRef.id;

            await db.runTransaction(async t => {
                t.set(newCommentRef, {
                    nickname: body.user.nickname, username: body.user.username, avatar: body.user.avatar,
                    content: body.content, timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                t.update(ref, { commentsCount: admin.firestore.FieldValue.increment(1) });
            });
            // 2. 返回 ID
            return res.json({ success: true, id: newCommentId });
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
