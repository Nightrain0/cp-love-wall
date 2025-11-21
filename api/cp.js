import admin from 'firebase-admin';

// 防止冷启动多次初始化 & 环境变量检查
if (!admin.apps.length) {
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (e) {
            console.error("❌ Firebase Init Error:", e);
        }
    } else {
        console.error("❌ Missing FIREBASE_CREDENTIALS");
    }
}

const getDb = () => {
    try { return admin.firestore(); } catch (e) { return null; }
};

const hashPassword = (pwd) => Buffer.from(pwd + "cpdd_salt").toString('base64');
const getIdentifier = (req, body) => body?.username ? 'user:'+body.username : 'ip:'+(req.headers['x-forwarded-for']||'unknown').split(',')[0];
// 生成唯一的聊天室ID (按字母顺序排序，保证 A和B无论谁发，都在同一个房间)
const getChatId = (u1, u2) => [u1, u2].sort().join('_');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const db = getDb();
    if (!db) return res.status(500).json({ error: '数据库连接失败' });

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

        // ==========================================
        // 1. 社交增强模块 (新功能)
        // ==========================================

        // 获取他人公开资料
        if (req.method === 'GET' && action === 'get_user_profile') {
            const targetUsername = req.query.username;
            if (!targetUsername) return res.status(400).json({ error: '缺参数' });
            
            const doc = await db.collection('cp_users').doc(targetUsername).get();
            if (!doc.exists) return res.status(404).json({ error: '用户不存在' });
            
            const d = doc.data();
            // 只返回公开信息，不返回密码
            const profile = {
                username: d.username,
                nickname: d.nickname,
                avatar: d.avatar,
                gender: d.gender || 'secret',
                target: d.target || 'all',
                qq: d.qq || '',
                wx: d.wx || '',
                createdAt: d.createdAt
            };
            return res.json(profile);
        }

        // 发送私信
        if (req.method === 'POST' && action === 'chat_send') {
            const { user, toUsername, content } = body;
            if (!user) return res.status(401).json({ error: '请登录' });
            if (!content) return res.status(400).json({ error: '内容为空' });

            const chatId = getChatId(user.username, toUsername);
            const chatRef = db.collection('cp_chats').doc(chatId);
            const msgRef = chatRef.collection('messages').doc();
            const now = admin.firestore.FieldValue.serverTimestamp();

            await db.runTransaction(async (t) => {
                // 1. 更新聊天室概览 (用于列表展示)
                const chatDoc = await t.get(chatRef);
                if (!chatDoc.exists) {
                    t.set(chatRef, {
                        participants: [user.username, toUsername],
                        lastMsg: content,
                        lastSender: user.username,
                        updatedAt: now
                    });
                } else {
                    t.update(chatRef, {
                        lastMsg: content,
                        lastSender: user.username,
                        updatedAt: now
                    });
                }
                // 2. 写入具体消息
                t.set(msgRef, {
                    sender: user.username,
                    content: content,
                    timestamp: now
                });
            });
            return res.json({ success: true });
        }

        // 获取私信会话列表 (收件箱)
        if (req.method === 'GET' && action === 'chat_inbox') {
            const myUsername = req.query.username;
            if (!myUsername) return res.status(400).json({ error: '缺参数' });

            // 查我参与的所有对话
            const snap = await db.collection('cp_chats')
                .where('participants', 'array-contains', myUsername)
                .orderBy('updatedAt', 'desc')
                .limit(20)
                .get();
            
            const chats = [];
            for (const doc of snap.docs) {
                const d = doc.data();
                const otherUser = d.participants.find(p => p !== myUsername);
                
                // 简单获取对方头像昵称 (实际项目建议把头像昵称冗余存到 chatRef 里，减少查询)
                let otherInfo = { nickname: otherUser, avatar: '' };
                const uDoc = await db.collection('cp_users').doc(otherUser).get();
                if (uDoc.exists) otherInfo = uDoc.data();

                chats.push({
                    chatId: doc.id,
                    otherUsername: otherUser,
                    otherNickname: otherInfo.nickname,
                    otherAvatar: otherInfo.avatar,
                    lastMsg: d.lastMsg,
                    updatedAt: d.updatedAt
                });
            }
            return res.json(chats);
        }

        // 获取具体对话详情
        if (req.method === 'GET' && action === 'chat_history') {
            const { u1, u2 } = req.query;
            const chatId = getChatId(u1, u2);
            
            const snap = await db.collection('cp_chats').doc(chatId).collection('messages')
                .orderBy('timestamp', 'asc') // 旧到新
                .limit(50)
                .get();
            
            const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            return res.json(msgs);
        }

        // ==========================================
        // 2. 鉴权模块
        // ==========================================
        
        if (action === 'register') {
            const { username, password, nickname, avatar } = body;
            // admin 不受限，其他人必须 >= 8
            if (username !== 'admin' && (!username || username.length < 8)) return res.status(400).json({ error: '账号需≥8位' });
            if (!password || password.length < 6) return res.status(400).json({ error: '密码需≥6位' });
            if (!nickname) return res.status(400).json({ error: '请输入昵称' });

            const userRef = db.collection('cp_users').doc(username);
            if ((await userRef.get()).exists) return res.status(400).json({ error: '账号已存在' });

            const u = { 
                username, password: hashPassword(password), nickname, avatar: avatar||'', 
                isAdmin: username==='admin', 
                gender: 'secret', target: 'all', qq: '', wx: '',
                createdAt: new Date() 
            };
            await userRef.set(u);
            delete u.password;
            return res.json({ success: true, user: u });
        }

        if (action === 'login') {
            const doc = await db.collection('cp_users').doc(body.username).get();
            if (!doc.exists) return res.status(400).json({ error: '账号不存在' });
            
            const u = doc.data();
            const now = Date.now();
            if (u.lockUntil && u.lockUntil.toMillis() > now) return res.status(403).json({ error: '账号已锁定，请稍后再试' });

            if (u.password !== hashPassword(body.password)) {
                let fails = (u.fails || 0) + 1;
                let updates = { fails };
                if (fails >= 3) updates.lockUntil = admin.firestore.Timestamp.fromMillis(now + 30*60*1000);
                await db.collection('cp_users').doc(body.username).update(updates);
                return res.status(400).json({ error: `密码错误 (剩余${3-fails}次)` });
            }
            
            if(u.fails) await db.collection('cp_users').doc(body.username).update({ fails: 0, lockUntil: null });
            u.isAdmin = (u.username === 'admin');
            delete u.password;
            return res.json({ success: true, user: u });
        }

        if (req.method === 'POST' && action === 'update_profile') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            if (body.user.username !== body.username) return res.status(403).json({ error: '非法操作' });

            const updates = {
                nickname: body.nickname, avatar: body.avatar,
                gender: body.gender || 'secret', target: body.target || 'all',
                qq: body.qq || '', wx: body.wx || ''
            };
            await db.collection('cp_users').doc(body.username).update(updates);
            
            const newDoc = await db.collection('cp_users').doc(body.username).get();
            const u = newDoc.data();
            delete u.password;
            return res.json({ success: true, user: u });
        }

        // ==========================================
        // 3. 帖子模块
        // ==========================================

        if (req.method === 'GET' && !action) {
            try {
                const snap = await db.collection('cp_posts').orderBy('timestamp', 'desc').limit(60).get();
                const posts = [];
                snap.forEach(d => {
                    const data = d.data();
                    let timeStr = "刚刚";
                    if(data.timestamp && data.timestamp._seconds) {
                        const dt = new Date(data.timestamp._seconds * 1000);
                        timeStr = `${dt.getMonth()+1}-${dt.getDate()} ${dt.getHours()}:${String(dt.getMinutes()).padStart(2,'0')}`;
                    }
                    posts.push({ id: d.id, ...data, timeStr, likedIds: data.likedIds||[] });
                });
                return res.json(posts);
            } catch(e) { return res.status(500).json({ error: '加载失败' }); }
        }

        if (req.method === 'POST' && action === 'create_post') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            await db.collection('cp_posts').add({
                nickname: body.user.nickname, username: body.user.username, avatar: body.user.avatar,
                gender: body.user.gender, target: body.user.target, qq: body.user.qq, wx: body.user.wx,
                game: body.game, desc: body.content, requirement: body.requirement, images: body.images,
                likes: 0, likedIds: [], commentsCount: 0, timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_post') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            const docRef = db.collection('cp_posts').doc(body.id);
            const doc = await docRef.get();
            if(!doc.exists) return res.json({success:true}); 
            if (body.user.username !== 'admin' && body.user.username !== doc.data().username) return res.status(403).json({ error: '无权操作' });
            await docRef.delete();
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'like') {
            const ref = db.collection('cp_posts').doc(body.id);
            const uid = getIdentifier(req, body.user);
            await db.runTransaction(async t => {
                const doc = await t.get(ref);
                if (!doc.exists) return;
                const d = doc.data();
                const ids = d.likedIds || [];
                const idx = ids.indexOf(uid);
                if (idx > -1) { ids.splice(idx, 1); t.update(ref, { likedIds: ids, likes: Math.max(0, (d.likes||0)-1) }); } 
                else { if(ids.length > 2000) ids.shift(); ids.push(uid); t.update(ref, { likedIds: ids, likes: (d.likes||0)+1 }); }
            });
            return res.json({ success: true });
        }

        if (req.method === 'GET' && action === 'get_comments') {
            const snap = await db.collection('cp_posts').doc(req.query.postId).collection('comments').orderBy('timestamp', 'asc').get();
            return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
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
                await cmtRef.delete();
                await ref.update({ commentsCount: admin.firestore.FieldValue.increment(-1) });
            }
            return res.json({ success: true });
        }

        return res.status(404).json({ error: 'API not found' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
}
